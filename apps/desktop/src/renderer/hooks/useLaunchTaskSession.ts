import { toast } from "@odin/ui/sonner";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { isVideoFile } from "shared/file-types";
import { machineLoad } from "shared/machine-load";
import { isOdinCwd, odinSessionInFlight, withOdinTag } from "shared/odin-tags";

function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
}

/** Single-quote a path for the shell — repo paths come off the user's disk. */
function quote(path: string): string {
	return `'${path.replaceAll("'", `'\\''`)}'`;
}

export function buildPrompt(
	title: string,
	description: string | null,
	attachmentPaths: string[] = [],
	skill?: string,
	unattended = false,
): string {
	return [
		// A skill leads the prompt, on its own line, with the title as its
		// argument — the shape a person types. Anywhere else in the text it's
		// prose about a skill rather than an invocation of one.
		skill ? `/${skill} ${title}` : `Task: ${title}`,
		...(description ? ["", description] : []),
		...(attachmentPaths.length > 0
			? [
					"",
					"Attached files — read them before starting:",
					...attachmentPaths,
					// The agent can't open a video: say so once, with the way in.
					...(attachmentPaths.some(isVideoFile)
						? [
								"",
								"Videos can't be read directly — pull frames first, e.g. `ffmpeg -i <video> -vf fps=1 /tmp/frame-%03d.png`, then read those.",
							]
						: []),
				]
			: []),
		"",
		"Work in the current workspace. Investigate, make the changes, and verify them when practical.",
		// A scheduled run reads exactly like one I typed, so the agent stops on
		// the first ambiguity and waits — at 4am, for hours, for nobody.
		...(unattended
			? [
					"",
					"This run was started by a schedule, not by a person — nobody is watching it. Don't stop to ask something you can settle with a sensible default: make the call, say which one you made, and leave the question in ACTION ITEMS.",
				]
			: []),
		// Every session lands on the board, and most of them land under "Needs
		// you" — where the only question being asked is "what do I have to do
		// about this one?". A turn that stops at "here's what I found" makes
		// you read the whole transcript to answer it.
		"",
		'Finish every reply with a section headed "ACTION ITEMS": a short numbered list of what I — the human reviewing this — have to do next (decide something, run or check something, unblock you). If there is nothing for me to do, write "ACTION ITEMS: none" and say why.',
	].join("\n");
}

/** Mime subtypes whose obvious extension isn't the subtype itself. */
const EXTENSIONS: Record<string, string> = {
	jpeg: "jpg",
	quicktime: "mov",
	"x-matroska": "mkv",
	"svg+xml": "svg",
};

/**
 * Split a `data:image/png;base64,…` (or `data:video/mp4;…`) URL into what the
 * filesystem router wants. Extension comes from the mime type, never the
 * original filename — the name is user-supplied and would need sanitising to
 * be safe in a path.
 */
export function parseDataUrl(dataUrl: string): {
	base64: string;
	extension: string;
} {
	const [header = "", base64 = ""] = dataUrl.split(",", 2);
	const subtype =
		/^data:(?:image|video)\/([a-z0-9.+-]+)/i.exec(header)?.[1]?.toLowerCase() ??
		"png";
	return {
		base64,
		extension: EXTENSIONS[subtype] ?? subtype.replace(/[^a-z0-9]/gi, ""),
	};
}

/** Which Odin view launched a session — "slack" is the retired reactions alias. */
export type OdinSource = "slack" | "reactions" | "jira" | "pr" | "notion";

/** A work-ledger row, as much of it as a board card needs. */
export interface DelegatedWork {
	title: string;
	person: string | null;
	externalId: string;
	source: string;
}

/**
 * What the board shows for a session: what the caller passed, filled in from
 * the work ledger's row for the same conversation.
 *
 * The caller wins everywhere except the title, and there the ledger does. A
 * resume only knows a conversation by what the transcript is called — Claude's
 * own summary of it, e.g. "Ingest and execute Slack thread task" — while the
 * ledger remembers the ask it was started from.
 */
export function boardIdentity(
	passed: {
		title: string;
		contact?: string | null;
		pageId?: string | null;
		source?: OdinSource;
		key?: string;
	},
	delegated?: DelegatedWork,
): {
	title: string;
	contact: string | null;
	pageId: string | null;
	source: OdinSource | undefined;
	key: string | undefined;
} {
	return {
		title: delegated?.title ?? passed.title,
		contact: passed.contact ?? delegated?.person ?? null,
		pageId: passed.pageId ?? delegated?.externalId ?? null,
		source: passed.source ?? (delegated?.source as OdinSource | undefined),
		key: passed.key ?? delegated?.externalId,
	};
}

/** How often to re-check while a launch is held back. */
const CAPACITY_POLL_MS = 5_000;
/**
 * Longest a launch waits for the machine to calm down. Past this it starts
 * anyway: a task that never runs is worse than a slow one, and the load may
 * be something that isn't going away (a long build, a VM).
 */
const CAPACITY_MAX_WAIT_MS = 10 * 60_000;

/** Whatever a launch is waiting on, reduced to "busy, and here's why". */
export interface LaunchBlocker {
	busy: boolean;
	reason: string | null;
}

/**
 * Hold a launch until what it needs is free — the Mac in one case, Odin's
 * checkout in the other.
 *
 * It re-reads and re-checks rather than deciding once: both readings are live
 * (CPU busy over the last few seconds; which sessions are running right now),
 * so a launch waits exactly as long as it has to.
 *
 * Any failure to read lets the launch through: a broken gauge must never be
 * the reason a session doesn't start.
 */
export async function waitForCapacity({
	readLoad,
	onWait,
	onProceed,
	skipped,
	pollMs = CAPACITY_POLL_MS,
	maxWaitMs = CAPACITY_MAX_WAIT_MS,
}: {
	readLoad: () => Promise<LaunchBlocker>;
	onWait: (load: LaunchBlocker) => void;
	onProceed: () => void;
	skipped: () => boolean;
	/** Overridden by tests only. */
	pollMs?: number;
	maxWaitMs?: number;
}): Promise<void> {
	const deadline = Date.now() + maxWaitMs;
	let waited = false;
	while (!skipped()) {
		let load: LaunchBlocker;
		try {
			load = await readLoad();
		} catch {
			break;
		}
		if (!load.busy) break;
		if (!waited) {
			waited = true;
			onWait(load);
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	if (waited) onProceed();
}

/**
 * An Odin launch past the gate but not yet spawned. Without it, three launches
 * held behind one session all see a free checkout on the tick it finishes and
 * start together: the pane they're waiting on only turns "working" once its
 * own launch finishes.
 */
let odinLaunchPending = false;

/**
 * Launch an agent session for an ad-hoc task into an existing workspace.
 * Shared by the Dev Board and Slack views.
 *
 * The command is passed to the pty-daemon as the pane's own process
 * (createOrAttach `command`) instead of being typed into a shell — typed
 * writes race cold shells and get swallowed (the empty-session bug).
 */
export function useLaunchTaskSession() {
	const utils = electronTrpc.useUtils();
	// Odin's own checkout, so a session that runs there gets #odin whether or
	// not the launching view thought to pass it.
	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	// The work ledger. Logged here rather than in each feed page: every feed
	// already hands `launch` the two things a row needs (`source` and `key`),
	// so one call site covers Slack, Jira, PRs and Notion at once.
	const recordWork = electronTrpc.workLog.record.useMutation();
	const [isLaunching, setIsLaunching] = useState(false);
	// Which row is launching, so the button that was clicked is the one that
	// says "Starting…" — a launch takes a second or two (git + PTY + agent
	// boot) and a click with no feedback reads as a dead button.
	const [launchingKey, setLaunchingKey] = useState<string | null>(null);
	// Set while a launch is parked waiting for the machine, so the caller's
	// "starting…" can say what it's actually waiting for.
	const [waitingReason, setWaitingReason] = useState<string | null>(null);

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
	}: {
		workspaceId: string;
		/** Caller's row id — echoed back as `launchingKey` while this runs. */
		key?: string;
		/**
		 * Run the agent in this checkout instead of the workspace worktree. The
		 * task file still lands in the workspace (that's the only fs the router
		 * will write to) — the agent reads it by absolute path.
		 */
		repoPath?: string;
		title: string;
		description: string | null;
		/** Open the agent at an empty prompt — no task file, nothing typed. */
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
		 * where it lies — copying gigabytes through IPC helps nobody.
		 */
		images?: { dataUrl?: string; path?: string }[];
		/** Board metadata, persisted on the pane (survives restarts + builds). */
		contact?: string | null;
		brief?: string | null;
		pageId?: string | null;
		/** Which Odin view launched this — the board groups cards by it. */
		source?: OdinSource;
		/** Board tags to stamp at launch (e.g. ["odin"] for work on Odin itself). */
		tags?: string[];
		/** Open the session by invoking this skill — `gdpr`, `plugin:name`. */
		skill?: string;
		/** Start now regardless of how loaded the machine is. */
		now?: boolean;
	}): Promise<
		| {
				ok: true;
				tabId: string;
				paneId: string;
				sessionId: string;
				/** Where the agent runs — the work ledger records it. */
				cwd: string;
		  }
		| { ok: false; error: string }
	> => {
		setIsLaunching(true);
		setLaunchingKey(key ?? null);
		// Only the launch that raised the Odin flag may lower it: a launch into
		// some other repo finishing in the meantime must not open the gate on an
		// Odin one that is still spawning.
		let raisedOdinFlag = false;
		try {
			const workspace = await utils.client.workspaces.get.query({
				id: workspaceId,
			});
			const worktreePath = workspace?.worktreePath;
			if (!worktreePath) {
				return {
					ok: false,
					error: "Workspace has no path — cannot launch a session",
				};
			}
			const sessionCwd = repoPath || worktreePath;

			// 0. Two gates, both of which hold the launch rather than refuse it:
			// every Odin view launches through here, so this is the one place
			// that decides when a new agent actually starts. "Start now" on
			// either toast clears both.
			let startNow = now === true;

			// 0a. Don't pile onto a machine that's already flat out.
			const toastId = `capacity-${key ?? title}`;
			await waitForCapacity({
				skipped: () => startNow,
				readLoad: async () =>
					machineLoad(await utils.client.resourceMetrics.getSnapshot.query()),
				onWait: (load) => {
					setWaitingReason(load.reason);
					toast.warning(`Machine busy — ${load.reason}`, {
						id: toastId,
						description: `Holding "${title}" until it frees up.`,
						duration: Number.POSITIVE_INFINITY,
						action: {
							label: "Start now",
							onClick: () => {
								startNow = true;
							},
						},
					});
				},
				onProceed: () => {
					setWaitingReason(null);
					toast.dismiss(toastId);
				},
			});

			// 0b. One agent in Odin's own checkout at a time. Work on Odin happens
			// in the checkout itself, so a second agent in there edits files under
			// the first and hands both of them a dirty tree. Queued, not refused:
			// a session you asked for should still run, just after the one ahead
			// of it — and no deadline, because starting anyway is the exact thing
			// this gate exists to prevent.
			const inOdin = isOdinCwd(sessionCwd, workConfig?.odinRepoPath);
			if (inOdin) {
				const odinToastId = `odin-queue-${key ?? title}`;
				await waitForCapacity({
					skipped: () => startNow,
					maxWaitMs: Number.POSITIVE_INFINITY,
					readLoad: async () => {
						if (odinLaunchPending)
							return { busy: true, reason: "another session is starting" };
						const held = odinSessionInFlight(
							Object.values(useTabsStore.getState().panes),
							workConfig?.odinRepoPath,
						);
						return {
							busy: !!held,
							reason: held ? `"${held.title}" is running` : null,
						};
					},
					onWait: (blocker) => {
						setWaitingReason(`Odin busy — ${blocker.reason}`);
						toast.warning(`Odin is busy — ${blocker.reason}`, {
							id: odinToastId,
							description: `Holding "${title}": one agent at a time in Odin's checkout.`,
							duration: Number.POSITIVE_INFINITY,
							action: {
								label: "Start now",
								onClick: () => {
									startNow = true;
								},
							},
						});
					},
					onProceed: () => {
						setWaitingReason(null);
						toast.dismiss(odinToastId);
					},
				});
				odinLaunchPending = true;
				raisedOdinFlag = true;
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
						tags?.includes("automation"),
					),
					encoding: "utf-8",
				});
				promptArg = ` "$(cat '${promptPath}')"`;
			}

			// 2. Tab + pane for the session
			const odinTags = withOdinTag(tags, sessionCwd, workConfig?.odinRepoPath);
			// Read the profile now rather than from a cached query: a switch a
			// moment ago must not stamp this session onto the profile you left.
			const odinProfile = (await utils.client.connections.profiles.query())
				.activeId;
			const { addTab, setTabAutoTitle, setPaneAutoTitle, setPaneStatus } =
				useTabsStore.getState();
			const { tabId, paneId } = addTab(workspaceId, {
				initialCwd: sessionCwd,
			});

			// 3. Spawn the session as the pane process — auto mode, prompt inlined.
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
			const claudeArgs = resumeSessionId
				? `--resume ${resumeSessionId}`
				: `--session-id ${sessionId}${promptArg}`;
			await utils.client.terminal.createOrAttach.mutate({
				paneId,
				tabId,
				workspaceId,
				cwd: sessionCwd,
				command: `cd ${quote(sessionCwd)} && claude --dangerously-skip-permissions ${claudeArgs}`,
			});

			// Resume rebuilds a pane for a conversation whose original one is gone
			// — and the board keeps a card's title, person and source on the pane,
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
			setPaneStatus(paneId, noPrompt || resumeSessionId ? "idle" : "working");
			// Persist the conversation id on the pane itself (app-state.json), so
			// Resume finds it from any build — renderer localStorage is per-app and
			// isn't shared between the dev and packaged apps.
			useTabsStore.setState((state) => ({
				panes: {
					...state.panes,
					[paneId]: {
						...state.panes[paneId],
						claudeSessionId: sessionId,
						odinTaskTitle: card.title,
						odinProfile,
						...(card.contact ? { odinContact: card.contact } : {}),
						...(brief ? { odinBrief: brief } : {}),
						...(card.pageId ? { odinPageId: card.pageId } : {}),
						...(card.source ? { odinSource: card.source } : {}),
						...(odinTags?.length ? { odinTags } : {}),
					},
				},
			}));
			// A row per external item I actually started an agent on, kept even
			// after the feed drops it. Sourceless launches (New Session, my own
			// tasks) aren't external work and get no row. Failing to log must
			// never cost you the session, so this is fire-and-forget.
			// ponytail: no externalUrl — source+externalId reconstructs it per
			// feed. Pass one through if a consumer ever needs it without the join.
			// Resuming re-records too, which re-points the ledger row at this
			// conversation — so the next resume finds it as well.
			if (card.source && card.key)
				recordWork.mutate({
					// "slack" is the retired alias for the reactions queue — same
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
			// agent ran — branch and PR are derived from it later.
			return { ok: true, tabId, paneId, sessionId, cwd: sessionCwd };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			// The pane is "working" by now, so the next queued launch sees it and
			// keeps waiting. Cleared on failure too — a launch that never started
			// must not hold the checkout shut.
			if (raisedOdinFlag) odinLaunchPending = false;
			setIsLaunching(false);
			setLaunchingKey(null);
			setWaitingReason(null);
		}
	};

	return { launch, isLaunching, launchingKey, waitingReason };
}
