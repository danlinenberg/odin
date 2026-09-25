import { useCallback, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SweptRow } from "../review/verdicts";
import { useBacklog } from "./builtin-automations";

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
	record: (swept: SweptRow[]) => void;
	forget: () => void;
}>()(
	persist(
		(set) => ({
			swept: [],
			sweptAt: null,
			sweeping: false,
			record: (swept) => set({ swept, sweptAt: Date.now() }),
			forget: () => set({ swept: [], sweptAt: null }),
		}),
		{
			name: "odin-backlog-review",
			partialize: ({ swept, sweptAt }) => ({ swept, sweptAt }),
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

// ponytail: fixed hourly; make it a setting if an hour turns out wrong.
export const SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * The sweep on a clock. Mounted in the shell, like the automation runner: a
 * schedule that only runs while Review is open isn't one. Checks once a
 * minute and sweeps when the last answers are an hour old, so a relaunch
 * after lunch sweeps straight away and a reload doesn't sweep twice.
 */
export function usePeriodicSweep(): void {
	const sweepBacklog = useSweepBacklog();
	// The interval reads the latest closure, not the one it was set up with.
	const latest = useRef(sweepBacklog);
	latest.current = sweepBacklog;
	useEffect(() => {
		// A failing sweep waits the full hour too, not a retry a minute.
		let triedAt = 0;
		const tick = () => {
			const { sweptAt } = useBacklogReview.getState();
			const last = Math.max(sweptAt ?? 0, triedAt);
			if (Date.now() - last < SWEEP_EVERY_MS) return;
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
