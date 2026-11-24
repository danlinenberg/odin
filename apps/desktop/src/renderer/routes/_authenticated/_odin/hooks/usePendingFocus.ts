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
	/** The session whose drawer is on screen now, or null. */
	shown: string | null;
	setShown: (paneId: string | null) => void;
}>((set) => ({
	paneId: null,
	at: 0,
	focus: (paneId) => set({ paneId, at: Date.now() }),
	clear: () => set({ paneId: null }),
	shown: null,
	setShown: (shown) => set({ shown }),
}));

/**
 * Why a session's request to move the window (another screen, another
 * profile) is refused, or null when it may go ahead. While a session is open
 * nothing but you, or that session itself, takes you off it.
 */
export function blockedMove(from: string | undefined): string | null {
	const { shown } = usePendingFocus.getState();
	if (!shown || from === shown) return null;
	return "Not done: a session is open on screen and Odin keeps it there. If the user asked for this in that session, call again from it with --data-urlencode from=$ODIN_PANE_ID.";
}
