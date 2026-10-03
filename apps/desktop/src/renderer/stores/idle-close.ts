import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Settings → Sessions: how long a session sits idle before the board closes it.
 * 0 = never. Renderer localStorage for the same reason as launch-limits: the
 * board's sweep is the only reader.
 */
export const useIdleClose = create<{
	hours: number;
	setHours: (hours: number) => void;
}>()(
	persist((set) => ({ hours: 3, setHours: (hours) => set({ hours }) }), {
		name: "odin-idle-close",
	}),
);
