import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Plenty for the sessions you'd come back to; the oldest draft drops first. */
const KEEP = 50;

/**
 * What you typed in a session's reply box and haven't sent, by pane, so it is
 * still there when you leave the session and come back. Sending clears it.
 * Oldest first: a save moves its pane to the end.
 */
export const useChatDrafts = create<{
	drafts: [paneId: string, text: string][];
	save: (paneId: string, text: string) => void;
}>()(
	persist(
		(set) => ({
			drafts: [],
			save: (paneId, text) =>
				set(({ drafts }) => {
					const rest = drafts.filter(([id]) => id !== paneId);
					return {
						drafts: text ? [...rest.slice(-(KEEP - 1)), [paneId, text]] : rest,
					};
				}),
		}),
		{ name: "odin-chat-drafts" },
	),
);

export const draftFor = (paneId: string) =>
	useChatDrafts.getState().drafts.find(([id]) => id === paneId)?.[1] ?? "";
