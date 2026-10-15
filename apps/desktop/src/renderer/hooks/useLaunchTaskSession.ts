import { useState } from "react";
import { currentLaunchBlocker } from "renderer/hooks/useTaskQueue";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { usePaneMeta } from "renderer/routes/_authenticated/_odin/hooks/usePaneMeta";
import { claudeLaunch } from "renderer/stores/claude-command";
import { rulesSettings, useOdinRules } from "renderer/stores/odin-rules";
import { useSessionInstructions } from "renderer/stores/session-instructions";
import { useTabsStore } from "renderer/stores/tabs/store";
import { claimedCheckout } from "shared/launch-gate";
import {
	boardIdentity,
	buildPrompt,
	DEFAULT_SESSION_INSTRUCTIONS,
	type DelegatedWork,
	type OdinSource,
	parseDataUrl,
	quote,
	slugify,
} from "shared/session-launch";

export {
	boardIdentity,
	buildPrompt,
	DEFAULT_SESSION_INSTRUCTIONS,
	type DelegatedWork,
	GUIDELINES_HEADER,
	type OdinSource,
	parseDataUrl,
	quote,
} from "shared/session-launch";

/**
 * Launch an agent session for an ad-hoc task into an existing workspace.
 * Shared by the Dev Board and Slack views.
 *
 * The command is passed to the pty-daemon as the pane's own process
 * (createOrAttach `command`) instead of being typed into a shell - typed
 * writes race cold shells and get swallowed (the empty-session bug).
 */
export function useLaunchTaskSession() {
	const utils = electronTrpc.useUtils();
	// Odin's own checkout, for the launch gate.
	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	// The work ledger. Logged here rather than in each feed page: every feed
	// already hands `launch` the two things a row needs (`source` and `key`),
	// so one call site covers Slack, Jira, PRs and Notion at once.
	const recordWork = electronTrpc.workLog.record.useMutation();
	const [isLaunching, setIsLaunching] = useState(false);
	// Which row is launching, so the button that was clicked is the one that
	// says "Starting…" - a launch takes a second or two (git + PTY + agent
	// boot) and a click with no feedback reads as a dead button.
	const [launchingKey, setLaunchingKey] = useState<string | null>(null);
	const launch = async ({
		workspaceId,
		title,
		description,
		contact,
		brief,
		pageId,
		source,
		noPrompt,
		images,
		tags,
		skill,
		resumeSessionId,
		repoPath,
		key,
		now,
		guidelines,
	}: {
		workspaceId: string;
		/** Caller's row id - echoed back as `launchingKey` while this runs. */
		key?: string;
		/**
		 * Run the agent in this checkout instead of the workspace worktree. The
		 * task file still lands in the workspace (that's the only fs the router
		 * will write to) - the agent reads it by absolute path.
		 */
		repoPath?: string;
		title: string;
		description: string | null;
		/** Open the agent at an empty prompt - no task file, nothing typed. */
		noPrompt?: boolean;
		/**
		 * Pick an existing Claude conversation back up (`claude --resume <id>`)
		 * instead of starting a fresh one. Used by the session search: the found
		 * session's pane is long gone, so resuming means a new pane on the old
		 * conversation id.
		 */
		resumeSessionId?: string;
		/**
		 * Images/videos to cite in the prompt. `dataUrl` bytes get written into
		 * the workspace; a `path` (a file already on disk, e.g. a video) is cited
		 * where it lies - copying gigabytes through IPC helps nobody.
		 */
		images?: { dataUrl?: string; path?: string }[];
		/** Board metadata, persisted on the pane (survives restarts + builds). */
		contact?: string | null;
		brief?: string | null;
		pageId?: string | null;
		/** Which Odin view launched this - the board groups cards by it. */
		source?: OdinSource;
		/** Board tags to stamp at launch (e.g. ["automation"]). */
		tags?: string[];
		/** Open the session by invoking this skill - `gdpr`, `plugin:name`. */
		skill?: string;
		/** Start now regardless of how loaded the machine is. */
		now?: boolean;
		/** Context the person added at start (`askSessionContext`). */
		guidelines?: string;
	}): Promise<
		| {
				ok: true;
				tabId: string;
				paneId: string;
				sessionId: string;
				/** Where the agent runs - the work ledger records it. */
				cwd: string;
				/** Created, but held in Idle until the gate clears. */
				queued: boolean;
		  }
		| { ok: false; error: string }
	> => {
		setIsLaunching(true);
		setLaunchingKey(key ?? null);
		try {
			const workspace = await utils.client.workspaces.get.query({
				id: workspaceId,
			});
			const worktreePath = workspace?.worktreePath;
			if (!worktreePath) {
				return {
					ok: false,
					error: "Workspace has no path - cannot launch a session",
				};
			}
			const sessionCwd = repoPath || worktreePath;
			// The checkout this session claims - "" for a feed launch into the
			// workspace folder, which is where agents start, not what they edit.
			const checkout = claimedCheckout(
				repoPath,
				worktreePath,
				workConfig?.odinRepoPath,
			);

			// A pinned --session-id is not proof Claude ever wrote the
			// conversation: a card Done'd or snoozed before Claude took its prompt
			// has none, and `claude --resume` then prints "No conversation found"
			// and exits - a fresh pane whose whole history is that line. The board's
			// Resume asks first; Remind me's Resume and Done's undo come through
			// here, so ask here too.
			if (resumeSessionId) {
				try {
					await utils.client.terminal.readClaudeTranscript.query({
						sessionId: resumeSessionId,
					});
				} catch (error) {
					// Only "no such conversation" is lost - an unreadable transcript
					// still resumes.
					if (String(error).includes("No transcript on this machine"))
						return {
							ok: false,
							error:
								"Claude never saved this conversation, so there is nothing to resume. Start the task again.",
						};
				}
			}

			// 0. Two gates - the Mac's headroom, and one agent at a time per
			// checkout. Read once, and never blocking: a launch that has to
			// wait still gets its card, and the queue runner starts the agent when
			// the gate clears. A failed read lets the launch through - a broken
			// gauge must not be the reason a session doesn't start.
			// An empty prompt hands the session straight back to you, so it isn't
			// held - and neither is a Resume, which reopens at an idle prompt too.
			// Idle takes no working slot and holds no checkout; queuing it only
			// left you on the board behind every task in line.
			let queuedReason: string | null = null;
			if (now !== true && !noPrompt && !resumeSessionId) {
				try {
					queuedReason = await currentLaunchBlocker(
						utils.client,
						checkout,
						workConfig?.odinRepoPath,
					);
				} catch {
					queuedReason = null;
				}
			}

			// 1. Prompt file in the workspace (survives quoting, keeps history)
			let promptArg = "";
			if (!noPrompt && !resumeSessionId) {
				const slug = slugify(title);
				const promptDir = `${worktreePath}/.odin`;
				const promptPath = `${promptDir}/task-${slug}.md`;
				await utils.client.filesystem.createDirectory.mutate({
					workspaceId,
					absolutePath: promptDir,
					recursive: true,
				});
				// Attachments land as real files next to the prompt: the agent reads
				// them from disk, so a path in the prompt is all it needs.
				const stamp = Date.now();
				const attachmentPaths: string[] = [];
				const inlined = (images ?? []).filter((file) => file.dataUrl);
				if (inlined.length > 0) {
					await utils.client.filesystem.createDirectory.mutate({
						workspaceId,
						absolutePath: `${promptDir}/attachments`,
						recursive: true,
					});
				}
				for (const [index, file] of (images ?? []).entries()) {
					if (!file.dataUrl) {
						// Already on disk (a video): cite it where it lies.
						if (file.path) attachmentPaths.push(file.path);
						continue;
					}
					const { base64, extension } = parseDataUrl(file.dataUrl);
					const filePath = `${promptDir}/attachments/${slug}-${stamp}-${index}.${extension}`;
					await utils.client.filesystem.writeFile.mutate({
						workspaceId,
						absolutePath: filePath,
						content: { kind: "base64", data: base64 },
					});
					attachmentPaths.push(filePath);
				}
				await utils.client.filesystem.writeFile.mutate({
					workspaceId,
					absolutePath: promptPath,
					content: buildPrompt(
						title,
						description,
						attachmentPaths,
						skill,
						tags?.some((tag) => tag === "automation" || tag === "off-hours"),
						useOdinRules.getState().rules,
						checkout,
						guidelines,
						useSessionInstructions.getState().instructions ??
							DEFAULT_SESSION_INSTRUCTIONS,
					),
					encoding: "utf-8",
				});
				promptArg = ` "$(cat '${promptPath}')"`;
			}

			// 2. Tab + pane for the session
			const odinTags = tags;
			// Read the profile now rather than from a cached query: a switch a
			// moment ago must not stamp this session onto the profile you left.
			const odinProfile = (await utils.client.connections.profiles.query())
				.activeId;
			const { addTab, setTabAutoTitle, setPaneAutoTitle, setPaneStatus } =
				useTabsStore.getState();
			const { tabId, paneId } = addTab(workspaceId, {
				initialCwd: sessionCwd,
			});

			// 3. Spawn the session as the pane process - auto mode, prompt inlined.
			// The cd is part of the command: the daemon's cwd param has proven
			// unreliable across PTY backends, and a wrong cwd sends the agent
			// to the wrong repo.
			//
			// --session-id pins Claude's conversation id up front, so Resume can
			// reattach to THIS exact conversation (`claude --resume <id>`).
			// `--continue` can't: it resumes whatever ran last in the directory,
			// and every Odin session shares one workspace cwd.
			// Resuming reuses the old conversation's id and sends no prompt: it
			// reopens the conversation at an idle prompt, it doesn't set the agent
			// working again. What to do next is yours to type.
			const sessionId = resumeSessionId ?? crypto.randomUUID();
			// Hooks live in the launch flags, not the conversation, so a resume
			// has to be handed them again - with today's rules, not the old ones.
			let settingsArg = "";
			const settings = rulesSettings(useOdinRules.getState().rules, checkout);
			if (settings) {
				const settingsDir = `${worktreePath}/.odin`;
				const settingsPath = `${settingsDir}/rules-${sessionId}.json`;
				// Best-effort: a session without its rule hook still beats a
				// launch or Resume that won't start.
				try {
					await utils.client.filesystem.createDirectory.mutate({
						workspaceId,
						absolutePath: settingsDir,
						recursive: true,
					});
					await utils.client.filesystem.writeFile.mutate({
						workspaceId,
						absolutePath: settingsPath,
						content: settings,
						encoding: "utf-8",
					});
					settingsArg = ` --settings ${quote(settingsPath)}`;
				} catch (error) {
					console.warn("[rules] could not write the rule hook:", error);
				}
			}
			const claudeArgs = resumeSessionId
				? `--resume ${resumeSessionId}${settingsArg}`
				: `--session-id ${sessionId}${settingsArg}${promptArg}`;
			const command = `cd ${quote(sessionCwd)} && ${claudeLaunch(title, claudeArgs, paneId)}`;
			// Held back: the pane stays process-less and the command rides on it
			// until the queue runner (useTaskQueue) finds the gate open.
			if (!queuedReason) {
				await utils.client.terminal.createOrAttach.mutate({
					paneId,
					tabId,
					workspaceId,
					cwd: sessionCwd,
					command,
				});
			}

			// Resume rebuilds a pane for a conversation whose original one is gone
			// - and the board keeps a card's title, person and source on the pane,
			// so Done'ing the card threw all of it away. Session History then
			// relaunched it under Claude's own generated title ("Ingest and
			// execute Slack thread task"), with no person and no feed item: the
			// ask nowhere on the card. The work ledger outlives the pane and is
			// keyed by the conversation id, so take the identity back from there.
			// Sessions older than the ledger, and terminals you opened yourself,
			// have no row and resume exactly as before.
			// Its own try: a card that comes back nameless is a nuisance, a resume
			// that refuses to start because the ledger couldn't be read is a
			// broken button.
			let delegated: DelegatedWork | undefined;
			if (resumeSessionId) {
				try {
					delegated = (
						await utils.client.workLog.list.query({ limit: 200 })
					).find((entry) => entry.sessionId === resumeSessionId);
				} catch {
					// no ledger (older install, or it hasn't migrated yet)
				}
			}
			const card = boardIdentity(
				{ title, contact, pageId, source, key },
				delegated,
			);

			setTabAutoTitle(tabId, card.title);
			setPaneAutoTitle(paneId, card.title);
			setPaneStatus(
				paneId,
				queuedReason || noPrompt || resumeSessionId ? "idle" : "working",
			);
			// Persist the conversation id on the pane itself (app-state.json), so
			// Resume finds it from any build - renderer localStorage is per-app and
			// isn't shared between the dev and packaged apps.
			useTabsStore.setState((state) => ({
				panes: {
					...state.panes,
					[paneId]: {
						...state.panes[paneId],
						claudeSessionId: sessionId,
						odinTaskTitle: card.title,
						odinProfile,
						...(checkout ? { odinCwd: checkout } : {}),
						...(card.contact ? { odinContact: card.contact } : {}),
						...(brief ? { odinBrief: brief } : {}),
						...(card.pageId ? { odinPageId: card.pageId } : {}),
						...(card.source ? { odinSource: card.source } : {}),
						...(odinTags?.length ? { odinTags } : {}),
						...(queuedReason
							? { odinQueued: { command, reason: queuedReason } }
							: {}),
					},
				},
			}));
			// Done dropped the old pane; what you wrote on its brief waited under
			// the conversation id for exactly this.
			if (resumeSessionId)
				usePaneMeta.getState().adoptSession(paneId, resumeSessionId);
			// A row per external item I actually started an agent on, kept even
			// after the feed drops it. Sourceless launches (New Session, my own
			// tasks) aren't external work and get no row. Failing to log must
			// never cost you the session, so this is fire-and-forget.
			// ponytail: no externalUrl - source+externalId reconstructs it per
			// feed. Pass one through if a consumer ever needs it without the join.
			// Resuming re-records too, which re-points the ledger row at this
			// conversation - so the next resume finds it as well.
			if (card.source && card.key)
				recordWork.mutate({
					// "slack" is the retired alias for the reactions queue - same
					// normalization boardSection does, so one item can't log twice
					// under two names.
					source: card.source === "slack" ? "reactions" : card.source,
					externalId: card.key,
					title: card.title,
					person: card.contact,
					cwd: sessionCwd,
					sessionId,
				});
			// cwd goes back to the caller so the work ledger can record where the
			// agent ran - branch and PR are derived from it later.
			return {
				ok: true,
				tabId,
				paneId,
				sessionId,
				cwd: sessionCwd,
				queued: !!queuedReason,
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			setIsLaunching(false);
			setLaunchingKey(null);
		}
	};

	return { launch, isLaunching, launchingKey };
}
