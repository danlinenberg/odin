import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Plenty for the sessions you'd come back to; the oldest draft drops first. */
const KEEP = 50;

/** How long typing pauses before the draft is written. */
export const SAVE_AFTER_MS = 400;

/**
 * What you typed in a message box and haven't sent, by box: a session's reply
 * box by its pane id, the other boxes by a fixed name (`new-session`,
 * `quick-add-task`, ...). Still there when you leave and come back, and after
 * Odin restarts or reloads its window. Sending clears it.
 * Oldest first: a save moves its box to the end.
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

/**
 * Keeps one box's draft in the store. A save rewrites every draft to
 * localStorage, too much for each keystroke, so typing saves once it pauses,
 * and `flush` saves at once (on the way out, and before the window unloads).
 * `sent` clears it now, and the text just sent is never written back, even by
 * a flush from a box that unmounts still showing it.
 */
export function draftKeeper(key: string) {
	let latest = draftFor(key);
	let sentText: string | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		clearTimeout(timer);
		timer = undefined;
		if (latest !== sentText) useChatDrafts.getState().save(key, latest);
	};
	return {
		initial: latest,
		type(text: string) {
			if (text === latest) return;
			latest = text;
			if (text !== sentText) sentText = null;
			clearTimeout(timer);
			timer = setTimeout(flush, SAVE_AFTER_MS);
		},
		flush,
		sent() {
			clearTimeout(timer);
			timer = undefined;
			sentText = latest;
			useChatDrafts.getState().save(key, "");
		},
	};
}

/**
 * useState for a message box's text that survives a remount, a window reload
 * and a restart. No key keeps it in memory only. `markSent` clears the stored
 * draft once the message went; empty the box with the setter as before.
 */
export function usePersistedDraft(
	key: string | undefined,
	initial = "",
): [
	string,
	React.Dispatch<React.SetStateAction<string>>,
	markSent: () => void,
] {
	const keeper = useMemo(() => (key ? draftKeeper(key) : null), [key]);
	const [draft, setDraft] = useState(() => keeper?.initial || initial);
	useEffect(() => keeper?.type(draft), [keeper, draft]);
	useEffect(() => {
		if (!keeper) return;
		// A restart, an update or a window reload unloads the page without
		// unmounting anything: save on the way out.
		window.addEventListener("beforeunload", keeper.flush);
		window.addEventListener("pagehide", keeper.flush);
		return () => {
			window.removeEventListener("beforeunload", keeper.flush);
			window.removeEventListener("pagehide", keeper.flush);
			keeper.flush();
		};
	}, [keeper]);
	return [draft, setDraft, () => keeper?.sent()];
}
