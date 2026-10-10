import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Plenty for the sessions you'd come back to; the oldest draft drops first. */
const KEEP = 50;

/**
 * What you typed in a session's reply box and haven't sent, by pane, so it is
 * still there when you leave the session and come back. Sending clears it.
 */
export const useChatDrafts = create<{
	drafts: Record<string, { text: string; at: number }>;
	save: (paneId: string, text: string) => void;
}>()(
	persist(
		(set) => ({
			drafts: {},
			save: (paneId, text) =>
				set(({ drafts }) => {
					const { [paneId]: _, ...rest } = drafts;
					if (!text) return { drafts: rest };
					// Newest-written first, so a tie on `at` keeps the newer draft.
					const kept = Object.entries(rest)
						.reverse()
						.sort(([, a], [, b]) => b.at - a.at)
						.slice(0, KEEP - 1);
					return {
						drafts: {
							...Object.fromEntries(kept),
							[paneId]: { text, at: Date.now() },
						},
					};
				}),
		}),
		{ name: "odin-chat-drafts" },
	),
);
