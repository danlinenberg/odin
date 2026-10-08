import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { launchLimits, useLaunchLimits } from "renderer/stores/launch-limits";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { claimedCheckout, launchBlocker } from "shared/launch-gate";

/**
 * Tasks created while the gate was shut, oldest first.
 *
 * Insertion order is creation order - panes are keyed by uuid and the store
 * rebuilds them from the persisted array in the same order - so the queue is
 * first-come-first-served without carrying a timestamp around.
 */
export function queuedPanes(panes: Record<string, Pane>): Pane[] {
	return Object.values(panes).filter((pane) => !!pane.odinQueued);
}

/** Where a queued pane's agent runs - set at launch, never confirmed since. */
function queuedCwd(pane: Pane): string {
	return pane.initialCwd ?? pane.cwd ?? "";
}

/**
 * The checkout a queued pane will claim when it starts - what the gate
 * compares. `odinCwd` survives opening the card; `initialCwd` doesn't.
 */
function queuedCheckout(pane: Pane, odinRepoPath: string | null | undefined) {
	return (
		pane.odinCwd ?? claimedCheckout(undefined, queuedCwd(pane), odinRepoPath)
	);
}

/** Panes whose PTY is alive in the daemon - the only ones that can be working. */
export function livePanes(
	panes: Record<string, Pane>,
	sessions: { sessionId: string; isAlive: boolean }[],
): Pane[] {
	const alive = new Set(
		sessions.filter((s) => s.isAlive).map((s) => s.sessionId),
	);
	return Object.values(panes).filter((pane) => alive.has(pane.id));
}

type TrpcClient = ReturnType<typeof electronTrpc.useUtils>["client"];

/**
 * `launchBlocker` against the live Mac and the live PTYs, read now - for a
 * one-off decision (a launch, a Resume) rather than the queue's poll.
 * `except` leaves a pane out: a Resume's own card can't block itself.
 */
export async function currentLaunchBlocker(
	client: TrpcClient,
	checkout: string,
	odinRepoPath: string | null | undefined,
	except?: string,
): Promise<string | null> {
	const [snapshot, { sessions }] = await Promise.all([
		client.resourceMetrics.getSnapshot.query(),
		client.terminal.listDaemonSessions.query(),
	]);
	return launchBlocker(
		snapshot,
		livePanes(useTabsStore.getState().panes, sessions).filter(
			(pane) => pane.id !== except,
		),
		checkout,
		odinRepoPath,
		launchLimits(useLaunchLimits.getState()),
	);
}

/**
 * Start a task that was held back: spawn the command its launch parked on the
 * pane, and clear the queue flag so the card leaves the Queued section.
 *
 * Killed first, like Resume does: opening a queued card in the workspace view
 * mounts a terminal, which attaches a plain shell to the pane - and
 * `createOrAttach` on a pane that already has a session ignores the command,
 * so the agent would never start. `allowKilled` for the same reason the pane
 * needs killing at all.
 */
export async function startQueuedPane(
	client: TrpcClient,
	pane: Pane,
): Promise<void> {
	const queued = pane.odinQueued;
	if (!queued) return;
	const tab = useTabsStore.getState().tabs.find((tab) => tab.id === pane.tabId);
	if (!tab) return;
	await client.terminal.kill.mutate({ paneId: pane.id }).catch(() => {});
	await client.terminal.createOrAttach.mutate({
		paneId: pane.id,
		tabId: pane.tabId,
		workspaceId: tab.workspaceId,
		cwd: queuedCwd(pane),
		command: queued.command,
		allowKilled: true,
	});
	useTabsStore.setState((state) => ({
		panes: {
			...state.panes,
			[pane.id]: {
				...state.panes[pane.id],
				// A Resume reopens at an idle prompt - nothing was asked of it -
				// unless it was queued with "Continue" on the end.
				status:
					/ --(resume|continue)\b/.test(queued.command) &&
					!queued.command.endsWith(" Continue")
						? "idle"
						: "working",
				odinQueued: undefined,
			},
		},
	}));
}

/**
 * Rewrite each waiting card's "why" to what's holding it now. The reason is
 * stamped at queue time, so without this a card kept naming a session that had
 * long since stopped.
 */
function refreshQueuedReasons(
	queue: Pane[],
	reasonFor: (pane: Pane) => string,
): void {
	const stale = queue.filter(
		(pane) => pane.odinQueued && pane.odinQueued.reason !== reasonFor(pane),
	);
	if (!stale.length) return;
	useTabsStore.setState((state) => {
		const panes = { ...state.panes };
		for (const pane of stale) {
			const current = panes[pane.id];
			if (!current?.odinQueued) continue;
			panes[pane.id] = {
				...current,
				odinQueued: { ...current.odinQueued, reason: reasonFor(pane) },
			};
		}
		return { panes };
	});
}

/**
 * The clock behind the Queued section: every poll, if the gate is open, start
 * the task that has waited longest.
 *
 * One per tick, deliberately - the session it just started turns the Odin gate
 * red and shows up in the next CPU reading, so the tick after it re-decides
 * against a machine that actually has the new agent on it.
 *
 * Mounted in the Odin shell rather than on the board: a queue that only drains
 * while you're looking at it isn't one.
 */
export function useTaskQueue(): void {
	const utils = electronTrpc.useUtils();
	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	// The same 5s snapshot the header chip reads - one shared query.
	const { data: metrics } = electronTrpc.resourceMetrics.getSnapshot.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);
	// Which PTYs are actually running. A restart kills every PTY but keeps each
	// pane's "working" status, so without this a dead card counted toward the
	// cap - and held its checkout - for good, and the queue never drained.
	const { data: daemonSessions } =
		electronTrpc.terminal.listDaemonSessions.useQuery(undefined, {
			refetchInterval: 5_000,
		});
	// A spawn takes a second or two; without this the next poll starts the same
	// card again while the first attach is still in flight.
	const starting = useRef(false);

	useEffect(() => {
		if (!metrics || !daemonSessions || starting.current) return;
		const panes = useTabsStore.getState().panes;
		const queue = queuedPanes(panes);
		if (!queue.length) return;
		const live = livePanes(panes, daemonSessions.sessions);
		const blockerFor = (pane: Pane) =>
			launchBlocker(
				metrics,
				live,
				queuedCheckout(pane, workConfig?.odinRepoPath),
				workConfig?.odinRepoPath,
				launchLimits(useLaunchLimits.getState()),
			);
		// The longest-waiting card that can go now - a card waiting on its own
		// busy repo doesn't hold back one aimed at a free repo.
		const next = queue.find((pane) => !blockerFor(pane));
		if (!next) {
			const blocker = blockerFor(queue[0]) ?? "";
			// Only the head waits on the blocker; the rest wait on the card ahead,
			// so repeating the blocker on every card says nothing new.
			refreshQueuedReasons(queue, (pane) => {
				const place = queue.indexOf(pane);
				return place === 0
					? blocker
					: `#${place + 1} in line, after "${queue[place - 1].odinTaskTitle ?? queue[place - 1].name}"`;
			});
			return;
		}
		starting.current = true;
		void startQueuedPane(utils.client, next)
			.catch(() => {
				// Leave it queued - the next tick tries again.
			})
			.finally(() => {
				starting.current = false;
			});
	}, [metrics, daemonSessions, workConfig, utils]);
}
