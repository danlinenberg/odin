import { useCallback, useEffect, useMemo, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useNextInLineDone } from "renderer/stores/next-in-line-done";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { keepDropped, type SweptRow } from "../review/verdicts";
import { useBacklog } from "./builtin-automations";

/** A row dropped from Review, as it was swept, and when. */
export type DroppedRow = SweptRow & { droppedAt: number };

// ponytail: fixed cap on drops the sweep no longer lists. Ones it still lists
// are always kept (see keepDropped), or a reload would put them back.
const DROPPED_KEPT = 100;

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
			partialize: ({ swept, sweptAt, sweepEveryHours, dropped }) => ({
				swept,
				sweptAt,
				sweepEveryHours,
				dropped,
			}),
		},
	),
);

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

/**
 * Done, whichever way it went: ✓ in Next in line, or Drop in Review. A Jira,
 * PR or Notion drop can't be cleared at its source, so without this it lived
 * on in All tasks and Next in line. By key, or by link for PRs, which the
 * feeds key by id and the sweep by repo#n.
 */
export function useIsDone(): (item: {
	key: string;
	url?: string | null;
}) => boolean {
	const done = useNextInLineDone((s) => s.done);
	const dropped = useBacklogReview((s) => s.dropped);
	return useMemo(() => {
		const keys = new Set(dropped.map((row) => row.key));
		const urls = new Set(dropped.flatMap((row) => (row.url ? [row.url] : [])));
		return (item) =>
			item.key in done ||
			keys.has(item.key) ||
			(!!item.url && urls.has(item.url));
	}, [done, dropped]);
}
