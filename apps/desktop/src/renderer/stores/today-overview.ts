import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The board's Today view. EXPERIMENT: off by default (`experiment`); Settings >
 * Advanced turns it on and adds the Today icon to the view toggle. With it on,
 * the board also switches to Today once a day, the first time it opens with
 * work on it (`enabled`; Settings → Running tasks turns that off). A fixed-size
 * singleton: two switches and the last day it was shown.
 */
export const useTodayOverview = create<{
	/** The experiment: the Today view exists at all. */
	experiment: boolean;
	/** Switch to Today by itself once a day. */
	enabled: boolean;
	/** Local `YYYY-MM-DD` it last opened by itself. */
	lastShown: string | null;
	setExperiment: (experiment: boolean) => void;
	setEnabled: (enabled: boolean) => void;
	markShown: (day: string) => void;
}>()(
	persist(
		(set) => ({
			experiment: false,
			enabled: true,
			lastShown: null,
			setExperiment: (experiment) => set({ experiment }),
			setEnabled: (enabled) => set({ enabled }),
			markShown: (day) => set({ lastShown: day }),
		}),
		{
			name: "odin-today-overview",
			// Only these three: older versions' chip and layout toggles drop out
			// of the saved value on its next write.
			partialize: ({ experiment, enabled, lastShown }) => ({
				experiment,
				enabled,
				lastShown,
			}),
		},
	),
);
