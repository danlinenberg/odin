import { create } from "zustand";
import { persist } from "zustand/middleware";

/** How many sessions the list remembers - the oldest view falls off. */
const KEEP = 20;
/** A session you haven't opened in two weeks isn't one you keep going back to. */
const KEEP_MS = 14 * 86_400_000;

/**
 * The sessions you opened in the board's drawer, by pane id, with when you
 * last did. The board filters on it and the session list sorts by it, so the
 * session you've opened five times today is one click away instead of a
 * scroll through every card named "Work on Odin".
 *
 * Bounded by KEEP and KEEP_MS; a pane that's gone just stops matching a card
 * and ages out.
 */
export const useRecentlyViewed = create<{
	viewedAt: Record<string, number>;
	view: (paneId: string) => void;
}>()(
	persist(
		(set) => ({
			viewedAt: {},
			view: (paneId) =>
				set((state) => ({ viewedAt: rememberView(state.viewedAt, paneId) })),
		}),
		{ name: "odin-recently-viewed" },
	),
);

export function rememberView(
	viewedAt: Record<string, number>,
	paneId: string,
	now = Date.now(),
): Record<string, number> {
	return Object.fromEntries(
		Object.entries({ ...viewedAt, [paneId]: now })
			.filter(([, at]) => now - at < KEEP_MS)
			.sort((a, b) => b[1] - a[1])
			.slice(0, KEEP),
	);
}
