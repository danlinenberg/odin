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

/** Live sessions whose chat is on screen, counted: GSD Mode runs in that view. */
export const useOpenChats = create<{
	count: Record<string, number>;
	open: (paneId: string, on: boolean) => void;
}>()((set) => ({
	count: {},
	open: (paneId, on) =>
		set((state) => {
			const { [paneId]: now = 0, ...rest } = state.count;
			const next = now + (on ? 1 : -1);
			return { count: next > 0 ? { ...rest, [paneId]: next } : rest };
		}),
}));
