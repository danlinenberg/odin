import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The board's Today view. EXPERIMENT: off by default (`experiment`); Settings >
 * Advanced turns it on and adds the Today icon to the view toggle. With it on,
 * the board also switches to Today once a day, the first time it opens with
 * work on it (`enabled`; Settings → Running tasks turns that off). Auto pilot is
 * its own experiment (`autoPilot`), also off by default. A fixed-size
 * singleton: three switches and the last day it was shown.
 */
export const useTodayOverview = create<{
	/** The experiment: the Today view exists at all. */
	experiment: boolean;
	/** The Auto pilot experiment: its top bar icon exists at all. */
	autoPilot: boolean;
	/** Switch to Today by itself once a day. */
	enabled: boolean;
	/** Local `YYYY-MM-DD` it last opened by itself. */
	lastShown: string | null;
	setExperiment: (experiment: boolean) => void;
	setAutoPilot: (autoPilot: boolean) => void;
	setEnabled: (enabled: boolean) => void;
	markShown: (day: string) => void;
}>()(
	persist(
		(set) => ({
			experiment: false,
			autoPilot: false,
			enabled: true,
			lastShown: null,
			setExperiment: (experiment) => set({ experiment }),
			setAutoPilot: (autoPilot) => set({ autoPilot }),
			setEnabled: (enabled) => set({ enabled }),
			markShown: (day) => set({ lastShown: day }),
		}),
		{
			name: "odin-today-overview",
			// Only these four: older versions' chip and layout toggles drop out
			// of the saved value on its next write.
			partialize: ({ experiment, autoPilot, enabled, lastShown }) => ({
				experiment,
				autoPilot,
				enabled,
				lastShown,
			}),
		},
	),
);
