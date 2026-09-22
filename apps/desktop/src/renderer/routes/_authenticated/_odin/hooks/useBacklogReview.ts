import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SweptRow } from "../review/verdicts";

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
	record: (swept: SweptRow[]) => void;
	forget: () => void;
}>()(
	persist(
		(set) => ({
			swept: [],
			sweptAt: null,
			record: (swept) => set({ swept, sweptAt: Date.now() }),
			forget: () => set({ swept: [], sweptAt: null }),
		}),
		{ name: "odin-backlog-review" },
	),
);
