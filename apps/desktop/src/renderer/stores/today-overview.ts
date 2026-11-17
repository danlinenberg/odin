import type { TodayGroup } from "renderer/routes/_authenticated/_odin/board/today";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The board's Today view. EXPERIMENT: off by default (`experiment`); Settings >
 * Advanced turns it on and adds the Today icon to the view toggle. With it on,
 * the board also switches to Today once a day, the first time it opens with
 * work on it (`enabled`; Settings → Sessions turns that off). A fixed-size
 * singleton: two switches, the last day it was shown, and the page's chip
 * toggles (at most the five groups hidden, and the due filter).
 */
export const useTodayOverview = create<{
	/** The experiment: the Today view exists at all. */
	experiment: boolean;
	/** Switch to Today by itself once a day. */
	enabled: boolean;
	/** Local `YYYY-MM-DD` it last opened by itself. */
	lastShown: string | null;
	/** Groups the chips toggled off: each shrinks to its heading line. */
	hidden: TodayGroup[];
	/** Due or overdue: only cards with a due date. */
	dueOnly: boolean;
	/** The "What we're working on" brief at the top is folded away. */
	briefClosed: boolean;
	setExperiment: (experiment: boolean) => void;
	setEnabled: (enabled: boolean) => void;
	markShown: (day: string) => void;
	setHidden: (hidden: TodayGroup[]) => void;
	setDueOnly: (dueOnly: boolean) => void;
	setBriefClosed: (briefClosed: boolean) => void;
}>()(
	persist(
		(set) => ({
			experiment: false,
			enabled: true,
			lastShown: null,
			hidden: [],
			dueOnly: false,
			briefClosed: false,
			setExperiment: (experiment) => set({ experiment }),
			setEnabled: (enabled) => set({ enabled }),
			markShown: (day) => set({ lastShown: day }),
			setHidden: (hidden) => set({ hidden }),
			setDueOnly: (dueOnly) => set({ dueOnly }),
			setBriefClosed: (briefClosed) => set({ briefClosed }),
		}),
		{ name: "odin-today-overview" },
	),
);
