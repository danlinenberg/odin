import { toast } from "@odin/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { parseDataUrl, quote } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { odinScreenStatus } from "shared/odin-screen-status";
import stripAnsi from "strip-ansi";
import { create } from "zustand";
import { type PromptImage, sessionTitle } from "../components/OdinPromptDialog";
import { useOdinWorkspace } from "./useOdinWorkspace";
import { usePendingFocus } from "./usePendingFocus";

/**
 * Marks the spare. A tag rather than a pane field of its own: `odinTags`
 * already survives the persist schema in main, a new field would be stripped
 * until main restarts. It isn't in TAG_VOCABULARY, so no card ever shows it.
 */
const WARM_TAG = "warm";

/**
 * Marks an asked question. Like the spare it has no title, so it's no card —
 * a question isn't a task. The board opens its drawer by this tag instead.
 */
export const QUESTION_TAG = "question";

/** The open question conversation — ✓ Done removes the pane, which ends it. */
export const questionPane = (panes: Record<string, Pane>): Pane | undefined =>
	Object.values(panes).find((pane) => pane.odinTags?.includes(QUESTION_TAG));

/** Long enough for a fresh spare to reach the daemon's session list. */
const SPAWN_GRACE_MS = 30_000;

/** How long a question waits for Claude's prompt when the spare is still booting. */
const READY_TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The spare: a Claude session with no title yet, so it isn't a board card. */
const warmPane = (panes: Record<string, Pane>): Pane | undefined =>
	Object.values(panes).find(
		(pane) => pane.odinTags?.includes(WARM_TAG) && !pane.odinTaskTitle,
	);

/** Who opens the Quick question dialog — the hotkey, or the board's button. */
export const useQuickQuestionDialog = create<{
	isOpen: boolean;
	setOpen: (isOpen: boolean) => void;
}>((set) => ({ isOpen: false, setOpen: (isOpen) => set({ isOpen }) }));

/**
 * Quick question: a Claude that's already up and sitting at its prompt, so a
 * question costs no boot. One spare runs hidden (no title, so it's no card);
 * asking types the question in and opens its drawer — still no card — and a
 * fresh spare starts behind it. The conversation persists: the next question
 * follows up in it, until ✓ Done in its drawer ends it.
 *
 * Mount once — the layout does. Returns `ask`.
 */
export function useQuickQuestion() {
	const utils = electronTrpc.useUtils();
	const navigate = useNavigate();
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
			command: `cd ${quote(cwd)} && claude --dangerously-skip-permissions --session-id ${sessionId}`,
		});
		return paneId;
	};
	const spawn = () => {
		spawning.current ??= startSpare()
			.catch((error) => {
				console.warn("[main] quick question: spare failed to start", error);
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
			// Persisted from a run whose daemon is gone — nothing in it to ask.
			useTabsStore.getState().removePane(pane.id);
		}
		return spawn();
	};

	// Keep one spare: on start, after each question takes it, and if it dies.
	// biome-ignore lint/correctness/useExhaustiveDependencies: ensureWarm reads the store, the two deps are the triggers
	useEffect(() => {
		if (daemon) void ensureWarm(daemon.sessions);
	}, [daemon, warmId]);

	/**
	 * The open conversation, live. A PTY that died with the daemon comes back
	 * with `claude --resume`. False for one Claude never wrote down — the
	 * question goes to the spare.
	 */
	const reopen = async (
		pane: Pane,
		sessions: { sessionId: string; isAlive: boolean }[],
		workspaceId: string,
		cwd: string,
	): Promise<boolean> => {
		if (sessions.some((s) => s.sessionId === pane.id && s.isAlive)) return true;
		const id = pane.claudeSessionId;
		const onDisk =
			!!id &&
			(await utils.client.terminal.readClaudeTranscript
				.query({ sessionId: id })
				.then(
					() => true,
					(error) => !String(error).includes("No transcript on this machine"),
				));
		if (!onDisk) return false;
		await utils.client.terminal.kill
			.mutate({ paneId: pane.id })
			.catch(() => {});
		await utils.client.terminal.createOrAttach.mutate({
			paneId: pane.id,
			tabId: pane.tabId,
			workspaceId,
			cwd,
			command: `cd ${quote(cwd)} && claude --dangerously-skip-permissions --resume ${id}`,
			allowKilled: true,
		});
		return true;
	};

	/** Wait for Claude's idle prompt — a spare that only just started may still be booting. */
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
				const screen = stripAnsi(result?.snapshot?.snapshotAnsi ?? "");
				// Still answering the last question counts: Claude queues a
				// follow-up typed mid-turn and takes it when the turn ends.
				const status = odinScreenStatus(screen);
				if (status === "review" || status === "working") return true;
			} catch {
				// An attach the drawer superseded — read again next tick.
			}
			await sleep(1_000);
		}
		return false;
	};

	const ask = async (raw: string, files: PromptImage[]): Promise<boolean> => {
		const question = raw.trim();
		if (!question && files.length === 0) return false;
		const { sessions } = await utils.client.terminal.listDaemonSessions.query();
		/** Where a pane's Claude runs — `initialCwd` is cleared once its drawer opens. */
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
		const open = questionPane(useTabsStore.getState().panes);
		const openAt = await placeOf(open);
		const followUp =
			!!open &&
			!!openAt &&
			(await reopen(open, sessions, openAt.workspaceId, openAt.cwd));
		// One that can't be followed up is over — the spare starts a new one.
		if (open && !followUp) useTabsStore.getState().removePane(open.id);
		const paneId = followUp ? open.id : await ensureWarm(sessions);
		const store = useTabsStore.getState();
		const pane = paneId ? store.panes[paneId] : undefined;
		const place = followUp ? openAt : await placeOf(pane);
		if (!pane || !place) {
			toast.error("Couldn't start a Claude session for the question");
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
			const filePath = `${attachments}/question-${Date.now()}-${index}.${extension}`;
			await utils.client.filesystem.writeFile.mutate({
				workspaceId,
				absolutePath: filePath,
				content: { kind: "base64", data: base64 },
			});
			paths.push(filePath);
		}
		const text = [question, ...paths].filter(Boolean).join("\n");

		// Claim the spare — no odinTaskTitle, so it stays off the board. A
		// follow-up keeps the conversation's first question as its title.
		if (!followUp) {
			const title = sessionTitle(question, "Quick question");
			store.setTabAutoTitle(pane.tabId, title);
			store.setPaneAutoTitle(pane.id, title);
			useTabsStore.setState((state) => ({
				panes: {
					...state.panes,
					[pane.id]: {
						...state.panes[pane.id],
						odinBrief: text,
						odinTags: [QUESTION_TAG],
					},
				},
			}));
		}
		store.setPaneStatus(pane.id, "working");
		usePendingFocus.getState().focus(pane.id);
		navigate({ to: "/board" });

		// Typed, not passed as an argument — the process is already running. As a
		// bracketed paste (Claude turns the mode on), so a multi-line question
		// lands whole instead of each newline submitting; Enter goes separately.
		void (async () => {
			if (!(await waitForPrompt(pane, workspaceId))) {
				useTabsStore.getState().setPaneStatus(pane.id, "permission");
				toast.error("Claude didn't reach its prompt — type the question in");
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

	return ask;
}
