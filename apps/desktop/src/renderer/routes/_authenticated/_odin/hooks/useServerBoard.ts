import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	isRemoteCoreMode,
	onRemoteCoreTargetChange,
	remoteCoreClient,
} from "renderer/lib/remote-core-link";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import {
	BOARD_PANES_KEY,
	type BoardPane,
	LAUNCH_CONTEXT_KEY,
	type LaunchContext,
	type PanePatches,
	SERVER_CARDS_KEY,
	SERVER_NIGHT_KEY,
	SERVER_PANE_PATCHES_KEY,
	type ServerCard,
	type ServerNight,
} from "shared/server-board";
import { mirrorJson, readServerState } from "./state-mirror";
import { useOdinTasks } from "./useOdinTasks";
import { useOdinWorkspace } from "./useOdinWorkspace";
import { usePaneMeta } from "./usePaneMeta";

/**
 * The window's half of the server's schedulers (main/odin-core/scheduler.ts),
 * while sessions run on a remote server:
 *
 * - tells the server where sessions start and what's on the board, so its
 *   automations, queue and Night Agent see what you see;
 * - puts the sessions the server started while you were away on the board,
 *   attached to their running sessions (a card's pane id is its session id);
 * - hands the server any task this window queued, so the queue drains with
 *   the laptop shut, and shows it starting when the server starts it;
 * - carries the server's Night Agent log and counts into Settings.
 */

const SYNC_EVERY_MS = 20_000;
const CONTEXT_EVERY_MS = 10 * 60_000;
const BOARD_PUSH_DELAY_MS = 3_000;
/** Cards the server started longer ago than this aren't put back on a fresh board. */
const ADOPT_WITHIN_MS = 7 * 86_400_000;
/** Server cards already put on this board (or closed from it), oldest first. */
const ADOPTED_KEY = "odin-server-cards-adopted";
const MAX_NIGHT_LOG = 300;
/** The newest server tag patch this board has applied, in ms. */
const PATCHES_AT_KEY = "odin-server-pane-patches-at";

function readAdopted(): string[] {
	try {
		return JSON.parse(localStorage.getItem(ADOPTED_KEY) ?? "[]");
	} catch {
		return [];
	}
}

function markAdopted(paneId: string): void {
	try {
		localStorage.setItem(
			ADOPTED_KEY,
			JSON.stringify([...readAdopted(), paneId].slice(-1000)),
		);
	} catch {
		// Storage full - the card may come back once; nothing worse.
	}
}

/** The board's cards, as much of each as the server's schedulers read. */
export function boardPanesOf(panes: Record<string, Pane>): BoardPane[] {
	return Object.values(panes)
		.filter((pane) => pane.odinTaskTitle)
		.map((pane) => ({
			id: pane.id,
			name: pane.name,
			...(pane.status ? { status: pane.status } : {}),
			...(pane.completed ? { completed: true } : {}),
			odinTaskTitle: pane.odinTaskTitle,
			...(pane.odinTags?.length ? { odinTags: pane.odinTags } : {}),
			...(pane.odinCwd ? { odinCwd: pane.odinCwd } : {}),
			...(pane.initialCwd ? { initialCwd: pane.initialCwd } : {}),
			...(pane.odinQueued ? { odinQueued: true } : {}),
		}));
}

/** What a queued command does once started: a resume reopens idle. */
function startedStatus(command: string): "idle" | "working" {
	return / --(resume|continue)\b/.test(command) &&
		!command.endsWith(" Continue")
		? "idle"
		: "working";
}

/** Put a session the server started on the board, attached to it. */
function adoptCard(card: ServerCard, workspaceId: string): void {
	const { setTabAutoTitle, setPaneAutoTitle, setPaneStatus } =
		useTabsStore.getState();
	useTabsStore.setState((state) => ({
		tabs: [
			...state.tabs,
			{
				id: card.tabId,
				name: card.title,
				workspaceId,
				layout: card.paneId,
				createdAt: card.createdAt,
			},
		],
		panes: {
			...state.panes,
			[card.paneId]: {
				id: card.paneId,
				tabId: card.tabId,
				type: "terminal",
				name: card.title,
				isNew: true,
				initialCwd: card.cwd,
				claudeSessionId: card.sessionId,
				odinTaskTitle: card.title,
				odinProfile: card.profileId,
				...(card.checkout ? { odinCwd: card.checkout } : {}),
				...(card.contact ? { odinContact: card.contact } : {}),
				...(card.brief ? { odinBrief: card.brief } : {}),
				...(card.pageId ? { odinPageId: card.pageId } : {}),
				...(card.source ? { odinSource: card.source } : {}),
				...(card.tags.length ? { odinTags: card.tags } : {}),
				...(card.queued ? { odinQueued: card.queued } : {}),
			},
		},
	}));
	setTabAutoTitle(card.tabId, card.title);
	setPaneAutoTitle(card.paneId, card.title);
	setPaneStatus(card.paneId, card.queued ? "idle" : "working");
	if (card.taskId) {
		const tasks = useOdinTasks.getState();
		tasks.setPane(card.taskId, card.paneId);
		// The window's own runner must not fire this minute again if remote
		// mode is switched off.
		if (card.origin === "automation")
			tasks.markRun(card.taskId, new Date(card.createdAt).setSeconds(0, 0));
	}
	if (card.slackRowId) {
		const meta = usePaneMeta.getState();
		meta.setTitle(card.paneId, card.title);
		meta.setSessionId(card.paneId, card.sessionId);
		meta.setPaneForPage(card.slackRowId, card.paneId);
	}
	markAdopted(card.paneId);
}

/** Queued cards the server started, or re-reasoned, since the last sync. */
function applyQueue(cards: ServerCard[]): void {
	const byPane = new Map(cards.map((card) => [card.paneId, card]));
	useTabsStore.setState((state) => {
		let changed = false;
		const panes = { ...state.panes };
		for (const pane of Object.values(state.panes)) {
			const card = byPane.get(pane.id);
			if (!pane.odinQueued || !card) continue;
			if (!card.queued) {
				panes[pane.id] = {
					...pane,
					status: startedStatus(pane.odinQueued.command),
					odinQueued: undefined,
				};
				changed = true;
			} else if (card.queued.reason !== pane.odinQueued.reason) {
				panes[pane.id] = {
					...pane,
					odinQueued: { ...pane.odinQueued, reason: card.queued.reason },
				};
				changed = true;
			}
		}
		return changed ? { panes } : state;
	});
}

/** The server's Night Agent, shown where the window's own one logs. */
function applyNight(night: ServerNight): void {
	const store = useNextInLinePrompt.getState();
	const lastAt = store.nightLog.at(-1)?.at ?? "";
	const fresh = night.log.filter((line) => line.at > lastAt);
	const picked = store.offHours.picked.filter(
		(key) => !night.picksStarted.includes(key),
	);
	useNextInLinePrompt.setState({
		...(fresh.length
			? { nightLog: [...store.nightLog, ...fresh].slice(-MAX_NIGHT_LOG) }
			: {}),
		offHoursStarted: night.started,
		offHoursFromPicks: night.fromPicks,
		nightLastTick: night.lastTick,
		...(picked.length !== store.offHours.picked.length
			? { offHours: { ...store.offHours, picked } }
			: {}),
	});
}

/** Card tags a server session changed (an automation done with a card). */
function applyPatches(patches: PanePatches): void {
	const since = Number(localStorage.getItem(PATCHES_AT_KEY) ?? 0);
	const fresh = Object.entries(patches).filter(([, patch]) => patch.at > since);
	if (!fresh.length) return;
	useTabsStore.setState((state) => {
		const panes = { ...state.panes };
		for (const [paneId, patch] of fresh) {
			const pane = panes[paneId];
			if (pane) panes[paneId] = { ...pane, odinTags: patch.odinTags };
		}
		return { panes };
	});
	try {
		localStorage.setItem(
			PATCHES_AT_KEY,
			String(Math.max(...fresh.map(([, patch]) => patch.at))),
		);
	} catch {
		// Re-applying the same tags next sync is harmless.
	}
}

/** Tasks this window queued: the server's queue starts them from here on. */ async function handOffQueued(
	cards: ServerCard[],
	handedOff: Set<string>,
): Promise<void> {
	const api = remoteCoreClient();
	if (!api) return;
	const known = new Set(cards.map((card) => card.paneId));
	for (const pane of Object.values(useTabsStore.getState().panes)) {
		if (!pane.odinQueued || known.has(pane.id) || handedOff.has(pane.id))
			continue;
		const cwd = pane.initialCwd ?? pane.cwd ?? "";
		if (!cwd) continue;
		handedOff.add(pane.id);
		await api.launcher.enqueue
			.mutate({
				paneId: pane.id,
				tabId: pane.tabId,
				sessionId: pane.claudeSessionId ?? "",
				cwd,
				checkout: pane.odinCwd ?? "",
				title: pane.odinTaskTitle ?? pane.name,
				tags: pane.odinTags ?? [],
				command: pane.odinQueued.command,
				reason: pane.odinQueued.reason,
			})
			.catch((error) => {
				handedOff.delete(pane.id);
				console.warn("[server-board] hand-off failed:", error);
			});
	}
}

/** Mount once (the Odin shell). Does nothing unless sessions run on a server. */
export function useServerBoard(): void {
	const utils = electronTrpc.useUtils();
	const { ensureWorkspace } = useOdinWorkspace();
	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	const latest = useRef({ ensureWorkspace, workConfig, utils });
	latest.current = { ensureWorkspace, workConfig, utils };

	useEffect(() => {
		const handedOff = new Set<string>();
		let syncing = false;
		let contextAt = 0;

		const pushContext = async () => {
			const ensured = await latest.current.ensureWorkspace(null, {
				askForFolder: false,
			});
			if (!ensured.ok) return;
			const workspace = await latest.current.utils.client.workspaces.get.query({
				id: ensured.workspace.id,
			});
			if (!workspace?.worktreePath) return;
			const context: LaunchContext = {
				workspacePath: workspace.worktreePath,
				odinRepoPath: latest.current.workConfig?.odinRepoPath ?? null,
			};
			await mirrorJson(LAUNCH_CONTEXT_KEY, context);
			contextAt = Date.now();
		};

		const sync = async () => {
			if (!isRemoteCoreMode() || syncing) return;
			syncing = true;
			try {
				if (Date.now() - contextAt > CONTEXT_EVERY_MS) await pushContext();
				await mirrorJson(
					BOARD_PANES_KEY,
					boardPanesOf(useTabsStore.getState().panes),
				);
				const state = await readServerState([
					SERVER_CARDS_KEY,
					SERVER_NIGHT_KEY,
					SERVER_PANE_PATCHES_KEY,
				]);
				const cards = (state[SERVER_CARDS_KEY] as ServerCard[]) ?? [];
				const adopted = new Set(readAdopted());
				const panes = useTabsStore.getState().panes;
				// Already on this board (a task it queued and handed over): closing
				// it later must not bring it back as a new card.
				for (const card of cards)
					if (panes[card.paneId] && !adopted.has(card.paneId)) {
						markAdopted(card.paneId);
						adopted.add(card.paneId);
					}
				const fresh = cards.filter(
					(card) =>
						!panes[card.paneId] &&
						!adopted.has(card.paneId) &&
						Date.now() - card.createdAt < ADOPT_WITHIN_MS,
				);
				if (fresh.length) {
					const ensured = await latest.current.ensureWorkspace(null, {
						askForFolder: false,
					});
					if (ensured.ok)
						for (const card of fresh) adoptCard(card, ensured.workspace.id);
				}
				applyQueue(cards);
				applyPatches((state[SERVER_PANE_PATCHES_KEY] as PanePatches) ?? {});
				await handOffQueued(cards, handedOff);
				const night = state[SERVER_NIGHT_KEY] as ServerNight | undefined;
				if (night) applyNight(night);
			} finally {
				syncing = false;
			}
		};
		const run = () => {
			sync().catch((error) =>
				console.warn("[server-board] sync failed:", error),
			);
		};

		// The board's cards go up shortly after they change, not only on the clock.
		let boardTimer: ReturnType<typeof setTimeout> | undefined;
		const stopBoard = useTabsStore.subscribe((state, previous) => {
			if (state.panes === previous.panes || !isRemoteCoreMode()) return;
			clearTimeout(boardTimer);
			boardTimer = setTimeout(() => {
				mirrorJson(BOARD_PANES_KEY, boardPanesOf(state.panes)).catch(() => {});
				// A launch that just queued is handed over without waiting a sync.
				if (Object.values(state.panes).some((pane) => pane.odinQueued)) run();
			}, BOARD_PUSH_DELAY_MS);
		});
		const stopTarget = onRemoteCoreTargetChange(() => {
			contextAt = 0;
			handedOff.clear();
			run();
		});
		const timer = setInterval(run, SYNC_EVERY_MS);
		run();
		return () => {
			stopBoard();
			stopTarget();
			clearInterval(timer);
			clearTimeout(boardTimer);
		};
	}, []);
}
