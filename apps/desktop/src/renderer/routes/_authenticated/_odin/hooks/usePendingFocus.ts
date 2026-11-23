import { create } from "zustand";

/** A request to open a session goes stale after this long without its card. */
export const PENDING_FOCUS_TTL_MS = 15_000;

/**
 * Cross-view handoff: the Tasks view sets the pane it just launched, then
 * navigates to the Dev Board, which opens that session's drawer and clears it.
 * `at` lets the board drop a request whose card never showed up: left
 * waiting, it opened that session much later (a host reconnecting brings its
 * cards back) and took you away from the one you were on.
 */
export const usePendingFocus = create<{
	paneId: string | null;
	at: number;
	focus: (paneId: string) => void;
	clear: () => void;
}>((set) => ({
	paneId: null,
	at: 0,
	focus: (paneId) => set({ paneId, at: Date.now() }),
	clear: () => set({ paneId: null }),
}));
