import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { launchBlocker } from "shared/launch-gate";

/**
 * Tasks created while the gate was shut, oldest first.
 *
 * Insertion order is creation order — panes are keyed by uuid and the store
 * rebuilds them from the persisted array in the same order — so the queue is
 * first-come-first-served without carrying a timestamp around.
 */
export function queuedPanes(panes: Record<string, Pane>): Pane[] {
	return Object.values(panes).filter((pane) => !!pane.odinQueued);
}

/** Where a queued pane's agent runs — set at launch, never confirmed since. */
function queuedCwd(pane: Pane): string {
	return pane.initialCwd ?? pane.cwd ?? "";
}

type TrpcClient = ReturnType<typeof electronTrpc.useUtils>["client"];

/**
 * Start a task that was held back: spawn the command its launch parked on the
 * pane, and clear the queue flag so the card leaves the Queued section.
 *
 * Killed first, like Resume does: opening a queued card in the workspace view
 * mounts a terminal, which attaches a plain shell to the pane — and
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
				status: "working",
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
 * One per tick, deliberately — the session it just started turns the Odin gate
 * red and shows up in the next CPU reading, so the tick after it re-decides
 * against a machine that actually has the new agent on it.
 *
 * Mounted in the Odin shell rather than on the board: a queue that only drains
 * while you're looking at it isn't one.
 */
export function useTaskQueue(): void {
	const utils = electronTrpc.useUtils();
	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	// The same 5s snapshot the header chip reads — one shared query.
	const { data: metrics } = electronTrpc.resourceMetrics.getSnapshot.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);
	// A spawn takes a second or two; without this the next poll starts the same
	// card again while the first attach is still in flight.
	const starting = useRef(false);

	useEffect(() => {
		if (!metrics || starting.current) return;
		const panes = useTabsStore.getState().panes;
		const queue = queuedPanes(panes);
		const next = queue[0];
		if (!next) return;
		const blocker = launchBlocker(
			metrics,
			Object.values(panes),
			queuedCwd(next),
			workConfig?.odinRepoPath,
		);
		if (blocker) {
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
				// Leave it queued — the next tick tries again.
			})
			.finally(() => {
				starting.current = false;
			});
	}, [metrics, workConfig, utils]);
}
