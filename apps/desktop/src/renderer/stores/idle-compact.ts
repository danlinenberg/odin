import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Settings → Sessions: how long a session sits out of Working, at a free
 * prompt, before the board types /compact into it. 0 = never. Renderer
 * localStorage for the same reason as idle-close: the board's sweep is the
 * only reader.
 */
export const useIdleCompact = create<{
	minutes: number;
	setMinutes: (minutes: number) => void;
}>()(
	persist(
		(set) => ({ minutes: 0, setMinutes: (minutes) => set({ minutes }) }),
		{
			name: "odin-idle-compact",
		},
	),
);
