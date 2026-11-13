import { create } from "zustand";

/**
 * The sessions in GSD Mode: their replies' `!` commands run without a
 * click. In memory only, so it is off again when Odin restarts.
 */
export const useDangerMode = create<{
	on: Record<string, true>;
	toggle: (paneId: string, on: boolean) => void;
}>()((set) => ({
	on: {},
	toggle: (paneId, on) =>
		set((state) => {
			const { [paneId]: _, ...rest } = state.on;
			return { on: on ? { ...rest, [paneId]: true } : rest };
		}),
}));
