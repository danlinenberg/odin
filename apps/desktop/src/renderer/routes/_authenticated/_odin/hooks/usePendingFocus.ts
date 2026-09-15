import { create } from "zustand";

/**
 * Cross-view handoff: the Tasks view sets the pane it just launched, then
 * navigates to the Dev Board, which opens that session's drawer and clears it.
 */
export const usePendingFocus = create<{
	paneId: string | null;
	focus: (paneId: string) => void;
	clear: () => void;
}>((set) => ({
	paneId: null,
	focus: (paneId) => set({ paneId }),
	clear: () => set({ paneId: null }),
}));
