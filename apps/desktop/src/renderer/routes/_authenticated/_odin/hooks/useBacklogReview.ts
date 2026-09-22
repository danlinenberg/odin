import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SweptItem } from "../review/verdicts";

/**
 * What the last sweep was asked about.
 *
 * The agent answers with item numbers, so something has to remember what
 * number 7 was. That is this: the list exactly as it went into the prompt,
 * kept on our side. Persisted because a sweep outlives a reload — it takes
 * minutes, and the app is not obliged to sit still for them.
 */
export const useBacklogReview = create<{
	/** Prompt order. Index 0 is item 1. */
	swept: SweptItem[];
	/** When the sweep was launched, ms. Not when it finished. */
	sweptAt: number | null;
	record: (swept: SweptItem[]) => void;
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
