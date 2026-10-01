import { useCallback, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useDoneStore } from "renderer/stores/done";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { keepDropped, type SweptRow } from "../review/verdicts";
import { useBacklog } from "./builtin-automations";

/** A row dropped from Review, as it was swept, and when. */
export type DroppedRow = SweptRow & { droppedAt: number };

// ponytail: fixed cap on drops the sweep no longer lists — 500, since one
// sweep can auto-drop 200+ and a 100 cap hid most of them from Undo. Ones it still lists
// are always kept (see keepDropped), or a reload would put them back.
const DROPPED_KEPT = 500;

/**
 * The last sweep's answers.
 *
 * Kept here rather than in the screen's state so leaving Review and coming
 * back doesn't mean sweeping again, and persisted so a reload doesn't either.
 * Small and fixed-size: one row per backlog item, replaced whole by the next
 * sweep.
 */
export const useBacklogReview = create<{
	swept: SweptRow[];
	/** When the sweep ran, ms. */
	sweptAt: number | null;
	/** A sweep is in flight — the button's or the clock's. Not persisted. */
	sweeping: boolean;
	/** How often the shell sweeps on its own, hours. 0 turns the clock off. */
	sweepEveryHours: number;
	/** What was dropped from Review, newest first. Not cleared by a sweep; see keepDropped. */
	dropped: DroppedRow[];
	/** DROPs already put in Done on the sweep's word, so an Undo sticks. */
	autoDone: string[];
	noteDropped: (row: SweptRow) => void;
	unnoteDropped: (key: string) => void;
	record: (swept: SweptRow[]) => void;
	setSweepEveryHours: (hours: number) => void;
	forget: () => void;
}>()(
	persist(
		(set) => ({
			swept: [],
			sweptAt: null,
			sweeping: false,
			sweepEveryHours: 1,
			dropped: [],
			autoDone: [],
			noteDropped: (row) =>
				set(({ dropped, swept }) => ({
					dropped: keepDropped(
						[
							{ ...row, droppedAt: Date.now() },
							...dropped.filter((d) => d.key !== row.key),
						],
						swept,
						DROPPED_KEPT,
					),
				})),
			unnoteDropped: (key) =>
				set(({ dropped }) => ({
					dropped: dropped.filter((d) => d.key !== key),
				})),
			record: (swept) =>
				set(({ dropped }) => ({
					swept,
					sweptAt: Date.now(),
					dropped: keepDropped(dropped, swept, DROPPED_KEPT),
				})),
			setSweepEveryHours: (sweepEveryHours) => set({ sweepEveryHours }),
			forget: () => set({ swept: [], sweptAt: null }),
		}),
		{
			name: "odin-backlog-review",
			partialize: ({ swept, sweptAt, sweepEveryHours, dropped, autoDone }) => ({
				swept,
				sweptAt,
				sweepEveryHours,
				dropped,
				autoDone,
			}),
		},
	),
);

/**
 * A sweep DROP is Done without waiting for you to drop it in Review: off
 * every feed and Next in line, listed under Review's Dropped and All tasks'
 * Done, where Undo brings it back for good. Once per row — a re-sweep that
 * still says DROP doesn't re-done what you undid. Nothing is deleted and a
 * live session keeps running; Review's own Drop does those.
 */
export function doneTheDrops(): void {
	const { swept, autoDone, noteDropped } = useBacklogReview.getState();
	const already = new Set(autoDone);
	const drops = swept.filter(
		(row) => row.verdict === "DROP" && !already.has(row.key),
	);
	const { setDone } = useDoneStore.getState();
	for (const row of drops) {
		noteDropped(row);
		setDone(row.key, {
			title: row.title,
			source: row.source,
			url: row.url ?? null,
		});
		if (row.key.startsWith("slack:"))
			electronTrpcClient.slack.setDone
				.mutate({ id: row.key.slice("slack:".length), done: true })
				.catch((error) => console.warn("[review] slack done failed", error));
	}
	// Only keys the sweep still lists; one it no longer lists can't come back.
	const listed = new Set(swept.map((row) => row.key));
	useBacklogReview.setState({
		autoDone: [
			...autoDone.filter((key) => listed.has(key)),
			...drops.map((row) => row.key),
		],
	});
}

/**
 * Every backlog row checked against the system it came from, answers into the
 * store. Resolves true when a sweep actually ran. Throws on failure.
 */
export function useSweepBacklog(): () => Promise<boolean> {
	const backlog = useBacklog();
	const sweep = electronTrpc.backlogReview.sweep.useMutation();
	return useCallback(async () => {
		const store = useBacklogReview.getState();
		if (store.sweeping || backlog.length === 0) return false;
		useBacklogReview.setState({ sweeping: true });
		try {
			const { rows: answers } = await sweep.mutateAsync({ items: backlog });
			// The answer carries the key, so what's rendered is the row as it was
			// swept — an item added while the sweep ran simply isn't in the list.
			const byKey = new Map(answers.map((row) => [row.key, row]));
			store.record(
				backlog.flatMap((item) => {
					const answer = byKey.get(item.key);
					if (!answer) return [];
					return [
						{
							key: item.key,
							source: item.source,
							title: item.title,
							...(item.url ? { url: item.url } : {}),
							verdict: answer.verdict,
							evidence: answer.evidence,
						},
					];
				}),
			);
			doneTheDrops();
			return true;
		} finally {
			useBacklogReview.setState({ sweeping: false });
		}
	}, [backlog, sweep.mutateAsync]);
}

/**
 * The sweep on a clock. Mounted in the shell, like the automation runner: a
 * schedule that only runs while Review is open isn't one. Checks once a
 * minute and sweeps when the last answers are older than the interval set in
 * Settings → Board, so a relaunch after lunch sweeps straight away and a
 * reload doesn't sweep twice. A new interval applies on the next tick.
 */
export function usePeriodicSweep(): void {
	const sweepBacklog = useSweepBacklog();
	// The interval reads the latest closure, not the one it was set up with.
	const latest = useRef(sweepBacklog);
	latest.current = sweepBacklog;
	useEffect(() => {
		// DROPs from a sweep that ran before this existed.
		doneTheDrops();
		// A failing sweep waits the full interval too, not a retry a minute.
		let triedAt = 0;
		const tick = () => {
			const { sweptAt, sweepEveryHours } = useBacklogReview.getState();
			if (sweepEveryHours <= 0) return;
			const last = Math.max(sweptAt ?? 0, triedAt);
			if (Date.now() - last < sweepEveryHours * 3_600_000) return;
			triedAt = Date.now();
			latest
				.current()
				.catch((error) =>
					console.warn("[review] periodic sweep failed", error),
				);
		};
		const id = setInterval(tick, 60_000);
		return () => clearInterval(id);
	}, []);
}
