import { toast } from "@odin/ui/sonner";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
	parseDataUrl,
	quote,
	useLaunchTaskSession,
} from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import {
	claudeWithFlags,
	crowModelFlag,
	pickClaudeCommand,
	useClaudeCommand,
} from "renderer/stores/claude-command";
import { type CrowChat, useCrowChats } from "renderer/stores/crow-chats";
import { useDismissedActions } from "renderer/stores/dismissed-actions";
import { useDoneStore } from "renderer/stores/done";
import {
	inOffHours,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useOneByOne } from "renderer/stores/one-by-one";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane, PaneStatus } from "renderer/stores/tabs/types";
import {
	lastAgentHookAt,
	runInSessionShell,
} from "renderer/stores/tabs/useAgentHookListener";
import { crowRule, NOTIFICATION_EVENTS } from "shared/constants";
import type { OdinActionRequest } from "shared/notification-types";
import { odinGuide } from "shared/odin-guide";
import {
	agentOnScreen,
	odinScreenStatus,
	spacesForCursorForward,
} from "shared/odin-screen-status";
import { CROW_TAG } from "shared/odin-tags";
import stripAnsi from "strip-ansi";
import { create } from "zustand";
import { useCardFlags } from "../board/card-flags";
import { phoneReply } from "../board/phone-resume";
import { remindSession } from "../board/SessionReminders";
import { type PromptImage, sessionTitle } from "../components/OdinPromptDialog";
import { unreadPing, useReplyWatch } from "../components/ReplyWatch";
import { phoneNights } from "../night-agent/night-log";
import { readState, runAction, writeState } from "./crow-state";
import { endSession, useDone } from "./useDone";
import { useOdinProfile } from "./useOdinProfile";
import { taskPrompt, useMyTasks, useOdinTasks } from "./useOdinTasks";
import { useOdinWorkspace } from "./useOdinWorkspace";
import { usePaneMeta } from "./usePaneMeta";
import { resumeSession } from "./useResumeSession";

/**
 * Marks the spare. A tag rather than a pane field of its own: `odinTags`
 * already survives the persist schema in main, a new field would be stripped
 * until main restarts. It isn't in TAG_VOCABULARY, so no card ever shows it.
 */
const WARM_TAG = "crow-spare";

/** The Quick question spare this replaced - started without the crow's rules. */
const LEGACY_WARM_TAG = "warm";

/** Re-exported for the board, which opens the crow's drawer by it. */
export { CROW_TAG };

/** The crow's open conversation - ✓ Done removes the pane, which ends it. */
export const crowPane = (panes: Record<string, Pane>): Pane | undefined =>
	Object.values(panes).find((pane) => pane.odinTags?.includes(CROW_TAG));

/**
 * Claude, told it is the crow and how to drive Odin. On Opus - the alias
 * always the latest one - unless the panel's picker says
 * otherwise; the board's sessions pick their own. Without Claude's own task
 * list, so "add a task" reaches Odin's backlog, and without its auto-memory,
 * so "always do X" becomes an Odin rule, not a memory file.
 */
export const crowCli = (args = "") => {
	const { commands, active, crowModel } = useClaudeCommand.getState();
	return claudeWithFlags(
		pickClaudeCommand(commands, active),
		`--dangerously-skip-permissions${crowModelFlag(crowModel)} --disallowedTools TaskCreate,TaskGet,TaskList,TaskUpdate,TodoWrite --settings ${quote(JSON.stringify({ autoMemoryEnabled: false }))} --append-system-prompt ${quote(crowRule)} ${args}`.trimEnd(),
	);
};

/** Long enough for a fresh spare to reach the daemon's session list. */
const SPAWN_GRACE_MS = 30_000;

/** How long a question waits for Claude's prompt when the spare is still booting. */
const READY_TIMEOUT_MS = 90_000;

/**
 * A turn silent this long is stuck (a hung tool, a request that never came
 * back): Claude never takes a message typed behind it, so a follow-up resumes
 * the conversation in a fresh process instead.
 */
const STUCK_MS = 10 * 60_000;

/**
 * How long Huginn's "working" has to go without a hook before his screen is
 * read to check it - the board's repair scan waits the same.
 */
const QUIET_MS = 120_000;

/**
 * What Huginn's screen says about a "working" the hooks went quiet on: the
 * status to write, or undefined to leave it. A turn cut with Esc or Ctrl+C
 * fires no Stop hook, and a restart can leave his PTY at a bare shell, so
 * without this the raven nodded "working" for a day. The board's scan repairs
 * its cards this way, but skips him: he has no task title.
 */
export function crowScreenRepair(screen: string): PaneStatus | undefined {
	if (!agentOnScreen(screen)) return "idle";
	const read = odinScreenStatus(screen);
	return read === "working" ? undefined : read;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The spare: a Claude session with no title yet, so it isn't a board card. */
const warmPane = (panes: Record<string, Pane>): Pane | undefined =>
	Object.values(panes).find(
		(pane) => pane.odinTags?.includes(WARM_TAG) && !pane.odinTaskTitle,
	);

/** Who opens the crow's dialog - the hotkey, or the crow button. */
export const useCrowDialog = create<{
	isOpen: boolean;
	setOpen: (isOpen: boolean) => void;
}>((set) => ({ isOpen: false, setOpen: (isOpen) => set({ isOpen }) }));

/**
 * The crow: Odin's own agent. A Claude that's already up and sitting at its
 * prompt, so asking costs no boot, and it answers in its own panel, and that can drive Odin through `/odin`
 * (crowRule) - list the backlog, start tasks, add one. Asking One spare runs hidden (no title, so it's no card);
 * types the ask in and opens its drawer - still no card - and a
 * fresh spare starts behind it. The conversation persists: the next question
 * follows up in it, until ✓ Done in its drawer ends it.
 *
 * Mount once - the layout does: it also answers the crow's `/odin` calls.
 * Returns `ask`, and `resume` for an earlier chat.
 */
export function useCrow() {
	const utils = electronTrpc.useUtils();
	const { ensureWorkspace } = useOdinWorkspace();
	const { data: daemon } = electronTrpc.terminal.listDaemonSessions.useQuery(
		undefined,
		{ refetchInterval: 15_000 },
	);
	const warmId = useTabsStore((s) => warmPane(s.panes)?.id);
	const spawning = useRef<Promise<string | null> | null>(null);
	const spawnedAt = useRef(0);

	/** Start a spare: the board's own launch, minus the prompt and the card. */
	const startSpare = async (): Promise<string | null> => {
		spawnedAt.current = Date.now();
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return null;
		const { id: workspaceId } = ensured.workspace;
		const cwd = (await utils.client.workspaces.get.query({ id: workspaceId }))
			?.worktreePath;
		if (!cwd) return null;
		const { tabId, paneId } = useTabsStore
			.getState()
			.addTab(workspaceId, { initialCwd: cwd });
		const sessionId = crypto.randomUUID();
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[paneId]: {
					...state.panes[paneId],
					claudeSessionId: sessionId,
					odinTags: [WARM_TAG],
				},
			},
		}));
		await utils.client.terminal.createOrAttach.mutate({
			paneId,
			tabId,
			workspaceId,
			cwd,
			command: `cd ${quote(cwd)} && ${crowCli(`--session-id ${sessionId}`)}`,
		});
		return paneId;
	};
	const spawn = () => {
		spawning.current ??= startSpare()
			.catch((error) => {
				console.warn("[main] crow: spare failed to start", error);
				return null;
			})
			.finally(() => {
				spawning.current = null;
			});
		return spawning.current;
	};

	/** The live spare, starting one if it's missing or its PTY died. */
	const ensureWarm = async (
		sessions: { sessionId: string; isAlive: boolean }[],
	): Promise<string | null> => {
		if (spawning.current) return spawning.current;
		const pane = warmPane(useTabsStore.getState().panes);
		if (pane) {
			const alive = sessions.some((s) => s.sessionId === pane.id && s.isAlive);
			if (alive || Date.now() - spawnedAt.current < SPAWN_GRACE_MS)
				return pane.id;
			// Persisted from a run whose daemon is gone - nothing in it to ask.
			useTabsStore.getState().removePane(pane.id);
		}
		return spawn();
	};

	// Quick question's spare has no crow rules - end it, the crow starts its own.
	useEffect(() => {
		const { panes, removePane } = useTabsStore.getState();
		for (const pane of Object.values(panes))
			if (pane.odinTags?.includes(LEGACY_WARM_TAG) && !pane.odinTaskTitle)
				removePane(pane.id);
	}, []);

	// Keep one spare: on start, after each ask takes it, and if it dies.
	// biome-ignore lint/correctness/useExhaustiveDependencies: ensureWarm reads the store, the two deps are the triggers
	useEffect(() => {
		if (daemon) void ensureWarm(daemon.sessions);
	}, [daemon, warmId]);

	/** Where a pane's Claude runs - `initialCwd` is cleared once its drawer opens. */
	const placeOf = async (pane: Pane | undefined) => {
		const workspaceId = useTabsStore
			.getState()
			.tabs.find((t) => t.id === pane?.tabId)?.workspaceId;
		const cwd =
			workspaceId &&
			(pane?.initialCwd ??
				(await utils.client.workspaces.get.query({ id: workspaceId }))
					?.worktreePath);
		return workspaceId && cwd ? { workspaceId, cwd } : undefined;
	};

	/** Claude back in the pane's PTY, on the conversation it wrote down. */
	const resumeIn = async (
		pane: Pane,
		workspaceId: string,
		cwd: string,
		sessionId: string,
	) => {
		await utils.client.terminal.kill
			.mutate({ paneId: pane.id })
			.catch(() => {});
		await utils.client.terminal.createOrAttach.mutate({
			paneId: pane.id,
			tabId: pane.tabId,
			workspaceId,
			cwd,
			command: `cd ${quote(cwd)} && ${crowCli(`--resume ${sessionId}`)}`,
			allowKilled: true,
		});
	};

	/**
	 * The open conversation, live. A PTY that died with the daemon comes back
	 * with `claude --resume`. False for one Claude never wrote down - the
	 * question goes to the spare.
	 */
	const reopen = async (
		pane: Pane,
		sessions: { sessionId: string; isAlive: boolean }[],
		workspaceId: string,
		cwd: string,
	): Promise<boolean> => {
		const alive = sessions.some((s) => s.sessionId === pane.id && s.isAlive);
		// His screen, not his status: a "working" a hook never cleared had the
		// follow-up kill a Claude sitting at his prompt and start him over, and
		// a PTY left at a bare shell took the question as a shell command.
		// Unreadable counts as Claude there, as before.
		const text = alive
			? await utils.client.terminal.readScreen
					.query({ paneId: pane.id })
					.then((read) => read.text)
					.catch(() => null)
			: null;
		const screen = text && stripAnsi(spacesForCursorForward(text));
		const live = alive && (!screen || agentOnScreen(screen));
		if (live && screen && odinScreenStatus(screen) !== "working") return true;
		if (live && pane.status !== "working") return true;
		const id = pane.claudeSessionId;
		const transcript = id
			? await utils.client.terminal.readClaudeTranscript
					.query({ sessionId: id })
					.catch((error) =>
						String(error).includes("No transcript on this machine")
							? null
							: undefined,
					)
			: null;
		if (live) {
			const at = transcript?.messages.at(-1)?.at;
			if (!at || Date.now() - Date.parse(at) < STUCK_MS) return true;
		}
		const onDisk = transcript !== null;
		if (!onDisk || !id) return false;
		await resumeIn(pane, workspaceId, cwd, id);
		return true;
	};

	// A new pick in the panel: the spare booted on the old model, so it goes
	// and the keep-one-spare effect starts one on the new. An open
	// conversation moves over with its history - a resume, as after a daemon
	// restart; one Claude hasn't written down yet stays put until New chat.
	const crowModel = useClaudeCommand((s) => s.crowModel);
	const lastModel = useRef(crowModel);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the pick is the trigger; the rest reads the store at call time
	useEffect(() => {
		if (lastModel.current === crowModel) return;
		lastModel.current = crowModel;
		void (async () => {
			// A spare mid-start lands first, so its PTY isn't orphaned.
			await spawning.current;
			const store = useTabsStore.getState();
			const spare = warmPane(store.panes);
			if (spare) store.removePane(spare.id);
			const open = crowPane(store.panes);
			const id = open?.claudeSessionId;
			if (!open || !id) return;
			const place = await placeOf(open);
			const onDisk = await utils.client.terminal.readClaudeTranscript
				.query({ sessionId: id })
				.then(
					() => true,
					() => false,
				);
			if (!place || !onDisk) return;
			await resumeIn(open, place.workspaceId, place.cwd, id);
			// Out of Working: a turn cut mid-way fires no Stop hook.
			useTabsStore.getState().setPaneStatus(open.id, "idle");
		})().catch((error) =>
			console.warn("[main] crow: could not switch model", error),
		);
	}, [crowModel]);

	/** Wait for Claude's idle prompt - a spare that only just started may still be booting. */
	const waitForPrompt = async (pane: Pane, workspaceId: string) => {
		for (const end = Date.now() + READY_TIMEOUT_MS; Date.now() < end; ) {
			// The drawer may already be showing it: read at its size, so the read
			// isn't a resize (same rule as the board's screen scan).
			const mounted = terminalCache.get(pane.id)?.xterm;
			try {
				const result = (await utils.client.terminal.createOrAttach.mutate({
					paneId: pane.id,
					tabId: pane.tabId,
					workspaceId,
					skipColdRestore: true,
					joinPending: true,
					...(mounted && { cols: mounted.cols, rows: mounted.rows }),
				})) as { snapshot?: { snapshotAnsi?: string } };
				const screen = stripAnsi(
					spacesForCursorForward(result?.snapshot?.snapshotAnsi ?? ""),
				);
				// Still answering the last question counts: Claude queues a
				// follow-up typed mid-turn and takes it when the turn ends.
				const status = odinScreenStatus(screen);
				if (status === "review" || status === "working") return true;
			} catch {
				// An attach the drawer superseded - read again next tick.
			}
			await sleep(1_000);
		}
		return false;
	};

	const ask = async (raw: string, files: PromptImage[]): Promise<boolean> => {
		const question = raw.trim();
		if (!question && files.length === 0) return false;
		const { sessions } = await utils.client.terminal.listDaemonSessions.query();
		const open = crowPane(useTabsStore.getState().panes);
		const openAt = await placeOf(open);
		const followUp =
			!!open &&
			!!openAt &&
			(await reopen(open, sessions, openAt.workspaceId, openAt.cwd));
		// One that can't be followed up is over - the spare starts a new one.
		if (open && !followUp) useTabsStore.getState().removePane(open.id);
		const paneId = followUp ? open.id : await ensureWarm(sessions);
		const store = useTabsStore.getState();
		const pane = paneId ? store.panes[paneId] : undefined;
		const place = followUp ? openAt : await placeOf(pane);
		if (!pane || !place) {
			toast.error("Couldn't start a Claude session for the raven");
			return false;
		}
		const { workspaceId } = place;

		// Attachments become files Claude reads by path, as in a launch.
		const paths: string[] = [];
		const attachments = `${place.cwd}/.odin/attachments`;
		if (files.some((file) => file.dataUrl))
			await utils.client.filesystem.createDirectory.mutate({
				workspaceId,
				absolutePath: attachments,
				recursive: true,
			});
		for (const [index, file] of files.entries()) {
			if (!file.dataUrl) {
				if (file.path) paths.push(file.path);
				continue;
			}
			const { base64, extension } = parseDataUrl(file.dataUrl);
			const filePath = `${attachments}/crow-${Date.now()}-${index}.${extension}`;
			await utils.client.filesystem.writeFile.mutate({
				workspaceId,
				absolutePath: filePath,
				content: { kind: "base64", data: base64 },
			});
			paths.push(filePath);
		}
		const text = [question, ...paths].filter(Boolean).join("\n");

		// Claim the spare - no odinTaskTitle, so it stays off the board. A
		// follow-up keeps the conversation's first question as its title.
		if (!followUp) {
			const title = sessionTitle(question, "Raven");
			if (pane.claudeSessionId)
				useCrowChats.getState().save({
					sessionId: pane.claudeSessionId,
					title,
					cwd: place.cwd,
					at: Date.now(),
				});
			store.setTabAutoTitle(pane.tabId, title);
			store.setPaneAutoTitle(pane.id, title);
			useTabsStore.setState((state) => ({
				panes: {
					...state.panes,
					[pane.id]: {
						...state.panes[pane.id],
						odinBrief: text,
						odinTags: [CROW_TAG],
					},
				},
			}));
		}
		// No navigation: the crow's panel shows the conversation where you asked.
		store.setPaneStatus(pane.id, "working");

		// Typed, not passed as an argument - the process is already running. As a
		// bracketed paste (Claude turns the mode on), so a multi-line question
		// lands whole instead of each newline submitting; Enter goes separately.
		void (async () => {
			if (!(await waitForPrompt(pane, workspaceId))) {
				useTabsStore.getState().setPaneStatus(pane.id, "permission");
				toast.error("Claude didn't reach its prompt - type it in");
				return;
			}
			await utils.client.terminal.write.mutate({
				paneId: pane.id,
				data: `\x1b[200~${text}\x1b[201~`,
			});
			await sleep(50);
			await utils.client.terminal.write.mutate({ paneId: pane.id, data: "\r" });
		})();
		return true;
	};

	/** An earlier chat, back as the open conversation - Claude resumes it. */
	const resume = async (chat: CrowChat): Promise<boolean> => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return false;
		const onDisk = await utils.client.terminal.readClaudeTranscript
			.query({ sessionId: chat.sessionId })
			.then(
				() => true,
				(error) => !String(error).includes("No transcript on this machine"),
			);
		if (!onDisk) {
			useCrowChats.getState().drop(chat.sessionId);
			toast.error("That chat is no longer on this computer");
			return false;
		}
		const open = crowPane(useTabsStore.getState().panes);
		if (open) endSession(open.id);
		const workspaceId = ensured.workspace.id;
		const store = useTabsStore.getState();
		const { tabId, paneId } = store.addTab(workspaceId, {
			initialCwd: chat.cwd,
		});
		store.setTabAutoTitle(tabId, chat.title);
		store.setPaneAutoTitle(paneId, chat.title);
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[paneId]: {
					...state.panes[paneId],
					claudeSessionId: chat.sessionId,
					odinTags: [CROW_TAG],
				},
			},
		}));
		await utils.client.terminal.createOrAttach.mutate({
			paneId,
			tabId,
			workspaceId,
			cwd: chat.cwd,
			command: `cd ${quote(chat.cwd)} && ${crowCli(`--resume ${chat.sessionId}`)}`,
		});
		useCrowChats.getState().save({ ...chat, at: Date.now() });
		// The panel shows a conversation once the daemon lists it alive.
		await utils.terminal.listDaemonSessions.invalidate();
		return true;
	};

	// The crow's `/odin` calls. Read off a ref at call time, so the
	// subscription isn't torn down on every store change.
	const { todos, add, setPane } = useMyTasks();
	const { isDone } = useDone();
	const { launch } = useLaunchTaskSession();
	const odinReply = electronTrpc.notifications.odinReply.useMutation();
	const router = useRouter();
	const { switchTo: switchProfile } = useOdinProfile();
	const deps = {
		switchProfile,
		todos,
		add,
		setPane,
		isDone,
		launch,
		ensureWorkspace,
		router,
	};
	const latest = useRef(deps);
	latest.current = deps;
	electronTrpc.notifications.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (event.type !== NOTIFICATION_EVENTS.ODIN_ACTION || !event.data) return;
			const request = event.data as OdinActionRequest;
			void Promise.resolve(runOdinAction(request, latest.current)).then(
				(text) => odinReply.mutate({ id: request.id, text }),
			);
		},
	});

	// Huginn stuck on "working" with no hook for a while: read his screen, and
	// write what two reads in a row agree on - one caught mid-repaint can lie.
	useEffect(() => {
		let lastRead: PaneStatus | undefined;
		const check = async () => {
			const pane = crowPane(useTabsStore.getState().panes);
			const since = Math.max(
				pane?.odinStatusAt ?? 0,
				(pane && lastAgentHookAt.get(pane.id)) || 0,
			);
			if (!pane || pane.status !== "working" || Date.now() - since < QUIET_MS) {
				lastRead = undefined;
				return;
			}
			const { text } = await utils.client.terminal.readScreen.query({
				paneId: pane.id,
			});
			// No screen: his PTY is gone, so nothing is working.
			const read = crowScreenRepair(
				stripAnsi(spacesForCursorForward(text ?? "")),
			);
			if (read && read === lastRead) {
				useTabsStore.getState().setPaneStatus(pane.id, read);
				lastRead = undefined;
			} else lastRead = read;
		};
		const timer = setInterval(() => void check().catch(() => {}), 15_000);
		return () => clearInterval(timer);
	}, [utils]);

	// One by one: start the next task once the last one stops working.
	useEffect(() => {
		let running = false;
		const tick = async () => {
			const { ids, paneId } = useOneByOne.getState();
			if (running || ids.length === 0) return;
			const last = paneId && useTabsStore.getState().panes[paneId];
			if (
				last &&
				!last.completed &&
				(last.status === "working" || !!last.odinQueued)
			)
				return;
			running = true;
			try {
				const [id, ...rest] = ids;
				const task = backlogOf(latest.current).find((t) => t.id === id);
				// Done or deleted since it was lined up: skip it.
				const started = task && (await launchTask(task, latest.current));
				useOneByOne.setState({ ids: rest, paneId: started || undefined });
			} finally {
				running = false;
			}
		};
		const timer = setInterval(() => void tick(), 15_000);
		return () => clearInterval(timer);
	}, []);

	return { ask, resume };
}

/** Start one backlog task on the board; its paneId, or null when it failed. */
async function launchTask(
	task: CrowDeps["todos"][number],
	deps: CrowDeps,
	onCreated?: (paneId: string) => void,
	onHost?: boolean,
): Promise<string | null> {
	const ensured = await deps.ensureWorkspace(null, { askForFolder: false });
	if (!ensured.ok) {
		toast.error(ensured.error);
		return null;
	}
	const result = await deps.launch({
		key: task.id,
		workspaceId: ensured.workspace.id,
		title: task.title,
		description: task.notes || null,
		brief: taskPrompt(task),
		skill: task.skill,
		repoPath: task.repo,
		onHost,
		onCreated: onCreated && ((created) => onCreated(created.paneId)),
	});
	if (!result.ok) {
		toast.error(`${task.title}: ${result.error}`);
		return null;
	}
	deps.setPane(task.id, result.paneId);
	return result.paneId;
}

/**
 * Start a task and answer its paneId as JSON the moment its card is on the
 * board - not when the launch resolves, which can sit behind the capacity gate.
 */
function openedPane(
	task: CrowDeps["todos"][number],
	deps: CrowDeps,
	onHost?: boolean,
): Promise<string> {
	return new Promise((resolve) => {
		const answer = (paneId: string | null) =>
			resolve(
				JSON.stringify(paneId ? { paneId } : { error: "Couldn't start it." }),
			);
		void launchTask(task, deps, answer, onHost).then(answer);
	});
}

/** The backlog: My Tasks minus automations and what's put away as Done. */
const backlogOf = (deps: CrowDeps) =>
	deps.todos.filter((task) => !deps.isDone({ key: `task:${task.id}` }));

type CrowDeps = {
	switchProfile: ReturnType<typeof useOdinProfile>["switchTo"];
	todos: ReturnType<typeof useMyTasks>["todos"];
	add: ReturnType<typeof useMyTasks>["add"];
	setPane: ReturnType<typeof useMyTasks>["setPane"];
	isDone: ReturnType<typeof useDone>["isDone"];
	launch: ReturnType<typeof useLaunchTaskSession>["launch"];
	ensureWorkspace: ReturnType<typeof useOdinWorkspace>["ensureWorkspace"];
	router: ReturnType<typeof useRouter>;
};

/** One `/odin` call, answered as the text the crow reads back. */
function runOdinAction(
	{ action, args }: OdinActionRequest,
	deps: CrowDeps,
): string | Promise<string> {
	const panes = useTabsStore.getState().panes;
	const started = (paneId?: string) =>
		!!paneId && !!panes[paneId] && !panes[paneId].completed;
	/** Why a started task hasn't run yet - the launch gate holds it. */
	const queued = (paneId?: string) =>
		paneId ? panes[paneId]?.odinQueued?.reason : undefined;
	if (action === "tasks")
		return JSON.stringify(
			backlogOf(deps).map((task) => ({
				id: task.id,
				title: task.title,
				priority: task.priority || 2,
				skill: task.skill,
				repo: task.repo,
				started: started(task.paneId),
				queued: queued(task.paneId),
			})),
		);
	if (action === "sessions")
		return JSON.stringify(
			Object.values(panes)
				.filter((pane) => pane.odinTaskTitle && !pane.completed)
				.map((pane) => ({
					paneId: pane.id,
					title: pane.odinTaskTitle,
					status: pane.odinQueued ? "queued" : (pane.status ?? "idle"),
					queued: pane.odinQueued?.reason,
				})),
		);
	if (action === "add") {
		if (!args.text?.trim()) return "Need text.";
		deps.add(args.text, undefined, args.repo || undefined);
		const title = args.text.trim().split("\n")[0];
		// The store puts a new task first: the one just added, as TaskBox's Start now reads it.
		const task =
			args.start === "true" ? useOdinTasks.getState().tasks[0] : undefined;
		if (!task) return `Added "${title}" to the backlog.`;
		// The phone opens the new session: its paneId as JSON, once its card is up.
		// The phone's Where pick; none keeps Settings' rule.
		const onHost = args.host ? args.host === "true" : undefined;
		if (args.open === "true") return openedPane(task, deps, onHost);
		// Not awaited: a launch can sit behind the machine's capacity gate.
		void launchTask(task, deps, undefined, onHost);
		return `Added "${title}" and started it on the board.`;
	}
	if (action === "profile") {
		// The same switch as the profile menu: the window follows, feeds reload.
		if (!args.id) return "Need id.";
		deps.switchProfile(args.id);
		return `Switched to profile ${args.id}.`;
	}
	if (action === "done-list") {
		// The All page's Done shelf, newest first: what you put away as Done.
		const rows = Object.entries(useDoneStore.getState().done)
			.filter(([, row]) => !row.reading)
			.sort(([, a], [, b]) => b.at - a.at)
			.slice(0, 40)
			.map(([key, row]) => ({ key, ...row }));
		return JSON.stringify(rows);
	}
	if (action === "card-flags") {
		// What the phone's board cards show beside the title, as the desktop
		// card does: "Dropped: PR merged" and the unread ping. And the column it
		// sits in, with "Ping me" sessions that wait on someone else marked.
		const { dropped, column } = useCardFlags.getState();
		const { watches } = useReplyWatch.getState();
		const flags: Record<
			string,
			{ dropped?: string; ping?: string; column?: string; waiting?: true }
		> = {};
		for (const id of Object.keys(panes)) {
			const ping = unreadPing(watches, id);
			const watched = Object.values(watches).some((w) => w.paneId === id);
			const waiting = watched && !ping && column[id] === "idle";
			if (dropped[id] || ping || column[id])
				flags[id] = {
					...(dropped[id] && { dropped: `Dropped: ${dropped[id]}` }),
					...(ping && { ping }),
					...(column[id] && { column: column[id] }),
					...(waiting && { waiting: true as const }),
				};
		}
		return JSON.stringify(flags);
	}
	if (action === "star") {
		const pane = args.paneId ? panes[args.paneId] : undefined;
		if (!pane)
			return "No session with that paneId - list them with action=sessions.";
		// Set, not flipped: a retried call can't undo itself.
		const starred = args.starred === "true";
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[pane.id]: { ...state.panes[pane.id], odinStarred: starred },
			},
		}));
		return `${starred ? "Starred" : "Unstarred"} ${pane.odinTaskTitle ?? pane.id}.`;
	}
	if (action === "start") {
		const ids = (args.ids ?? "").split(",").map((id) => id.trim());
		const tasks = backlogOf(deps).filter((task) => ids.includes(task.id));
		if (tasks.length === 0)
			return "No backlog task has those ids - list them with action=tasks.";
		if (args.one_by_one === "true") {
			// In the order asked, after what's already lined up - a second call
			// adds to the line, it doesn't start a second one beside it.
			const line = useOneByOne.getState().ids;
			const added = ids.filter(
				(id) => !line.includes(id) && tasks.some((task) => task.id === id),
			);
			useOneByOne.setState({ ids: [...line, ...added] });
			const title = (id: string) => tasks.find((task) => task.id === id)?.title;
			return `Lined up ${added.length} to run one by one (${line.length + added.length} waiting) - Odin starts each when the last stops working: ${added.map(title).join("; ")}`;
		}
		if (args.open === "true" && tasks.length === 1)
			return openedPane(tasks[0], deps);
		// Not awaited: a launch can sit behind the machine's capacity gate.
		void (async () => {
			for (const task of tasks) await launchTask(task, deps);
		})();
		return `Starting ${tasks.length} on the board: ${tasks.map((task) => task.title).join("; ")}`;
	}
	if (action === "night") {
		const { setOffHours } = useNextInLinePrompt.getState();
		const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
		for (const time of [args.start, args.end])
			if (time && !hhmm.test(time)) return `"${time}" isn't HH:MM.`;
		const max = args.max ? Number(args.max) : undefined;
		if (max !== undefined && !(Number.isInteger(max) && max > 0))
			return "max must be a whole number above 0.";
		if (args.on === "true" || args.on === "false")
			setOffHours({
				enabled: args.on === "true",
				...(args.start && { start: args.start }),
				...(args.end && { end: args.end }),
				...(max && { maxSessions: max }),
			});
		const { offHours: now, nightLog } = useNextInLinePrompt.getState();
		const status = now.enabled
			? `Night Agent is on: ${now.start} to ${now.end}, at most ${now.maxSessions} sessions, one at a time from the top of Next in line.`
			: "Night Agent is off.";
		const log = nightLog
			.slice(-60)
			.map((entry) => `${new Date(entry.at).toLocaleString()}  ${entry.event}`);
		return log.length
			? `${status}\n\nWhat it did, newest last:\n${log.join("\n")}`
			: `${status}\n\nNo night has run yet.`;
	}
	if (action === "night-page") {
		// The phone's Night Agent page: the schedule, tonight's count, the nights.
		const { offHours, offHoursStarted, nightLog } =
			useNextInLinePrompt.getState();
		const paneOf = (sessionId: string) =>
			Object.values(panes).find((pane) => pane.claudeSessionId === sessionId)
				?.id;
		return JSON.stringify({
			enabled: offHours.enabled,
			start: offHours.start,
			end: offHours.end,
			maxSessions: offHours.maxSessions,
			running:
				offHours.enabled &&
				inOffHours(new Date(), offHours.start, offHours.end),
			startedTonight: offHoursStarted,
			nights: phoneNights(nightLog, offHours, paneOf),
		});
	}
	if (action === "guide") return odinGuide(args.q);
	if (action === "state") return readState(args);
	if (action === "set") return writeState(args);
	if (action === "run") return runAction(args);
	if (action === "open") {
		const screens = Object.keys(deps.router.routesByPath).filter(
			(path) => !path.includes("$"),
		);
		if (!args.to) return `Screens: ${screens.join(", ")}`;
		void deps.router.navigate({ to: args.to });
		return `Opened ${args.to}.`;
	}
	// The phone's reply: resume an exited session with it, or "live".
	if (action === "phone-reply")
		return phoneReply(args.paneId ?? "", args.text ?? "");
	// A `!local` block's Run on the phone: the session's Shell runs it here.
	if (action === "run-local") {
		const pane = args.paneId ? panes[args.paneId] : undefined;
		const workspaceId = useTabsStore
			.getState()
			.tabs.find((tab) => tab.id === pane?.tabId)?.workspaceId;
		if (!pane || !workspaceId || !args.command)
			return "No session with that paneId.";
		void runInSessionShell(pane.id, workspaceId, args.command, "local");
		return "ok";
	}
	// The phone's X on an action item: as the board's, it hides the item in
	// later replies, and the next message tells Claude.
	if (action === "dismiss-item") {
		if (!args.paneId || !args.item) return "Need paneId and item.";
		useDismissedActions.getState().dismiss(args.paneId, args.item);
		return "ok";
	}
	// The items dismissed in a session; `take` also hands over the ones Claude
	// hasn't been told about yet, for the phone's reply to carry.
	if (action === "dismissed") {
		const paneId = args.paneId ?? "";
		const store = useDismissedActions.getState();
		const items =
			store.panes.find((pane) => pane.paneId === paneId)?.items ?? [];
		const untold = args.take === "true" ? store.takeUntold(paneId) : [];
		return JSON.stringify({ items, untold });
	}
	// The phone stopped a turn: as the board's Stop, the card leaves Working.
	if (action === "interrupted") {
		const paneId = args.paneId;
		if (!paneId || !panes[paneId]) return "No session with that paneId.";
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[paneId]: {
					...state.panes[paneId],
					status: args.sent === "true" ? "idle" : "review",
				},
			},
		}));
		return "ok";
	}
	if (action === "done") {
		if (!args.paneId || !panes[args.paneId])
			return "No session with that paneId - list them with action=sessions.";
		endSession(args.paneId);
		return `Marked ${panes[args.paneId].odinTaskTitle ?? args.paneId} done.`;
	}
	// The phone's Resume on a session off the board: as Session History's,
	// a new card resuming the conversation. Answers its paneId as JSON.
	if (action === "resume") {
		if (!args.sessionId || !args.cwd) return "Need sessionId and cwd.";
		const live = Object.values(panes).find(
			(pane) => pane.claudeSessionId === args.sessionId && !pane.completed,
		);
		if (live) return JSON.stringify({ paneId: live.id });
		return resumeSession(
			{
				sessionId: args.sessionId,
				cwd: args.cwd,
				title: args.title || "Session",
				prompt: args.prompt || null,
			},
			deps,
		).then((result) =>
			JSON.stringify(
				result.ok ? { paneId: result.paneId } : { error: result.error },
			),
		);
	}
	// The phone's Remind me: as the board's bell, done now and back on `day`.
	if (action === "remind") {
		const pane = args.paneId ? panes[args.paneId] : undefined;
		if (!pane || !args.day)
			return "Need the paneId of a session and a day (YYYY-MM-DD).";
		const meta = usePaneMeta.getState();
		const sessionId = pane.claudeSessionId ?? meta.sessionIdByPane[pane.id];
		const cwd = pane.cwd ?? pane.initialCwd;
		if (!sessionId || !cwd)
			return "This session has no conversation id - can't resume it later.";
		const title = pane.odinTaskTitle ?? pane.name ?? "Session";
		remindSession(
			{ sessionId, cwd, title, brief: meta.briefByPane[pane.id] },
			args.day,
		);
		endSession(pane.id);
		return `Reminding you ${args.day} - ${title}.`;
	}
	return `Unknown action "${action}" - use guide, tasks, start, add, star, sessions, night, done, remind, resume, state, set, open, api or call.`;
}
