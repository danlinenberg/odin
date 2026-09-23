import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface BriefLink {
	url: string;
	/** What you called it when you added it — "deploy thread", "QA sheet". */
	name?: string;
}

export const linkUrl = (link: BriefLink | string) =>
	typeof link === "string" ? link : link.url;

/**
 * Extra board metadata that isn't part of the tabs store, keyed by paneId and
 * persisted so it survives app restart:
 *  - contact: point-of-contact → the card's colored person chip.
 *  - brief:   what the task is about → shown on card hover (the terminal only
 *             shows the agent's live chatter, not the original ask).
 *  - notes:   whatever you typed into the session brief panel yourself — the
 *             written brief is regenerated from the transcript, so your own
 *             "don't forget X" needs somewhere of its own to live.
 *  - links:   resources you attached to the brief yourself (another Slack
 *             thread, a doc) — the brief only finds what the transcript quotes.
 *  - hidden:  resources the transcript surfaced that you don't want on the
 *             brief — kept under its collapsed "Hidden" section, not dropped.
 */
export const usePaneMeta = create<{
	contactByPane: Record<string, string>;
	briefByPane: Record<string, string>;
	notesByPane: Record<string, string>;
	/** Plain strings are links saved before they could carry a name. */
	linksByPane: Record<string, (BriefLink | string)[]>;
	/** URLs hidden from the brief, per pane. */
	hiddenByPane: Record<string, string[]>;
	/** Task title captured at launch — Claude Code's OSC title overwrites the
	 *  pane name/userTitle to "Claude Code", so the board reads this instead. */
	titleByPane: Record<string, string>;
	/** Claude Code session id we assigned at launch (--session-id), so Resume
	 *  can reattach to THIS conversation via --resume instead of guessing with
	 *  --continue (which resumes whatever ran last in the same directory). */
	sessionIdByPane: Record<string, string>;
	/** Notion pageId → paneId, so a task row knows it already has a session
	 *  (and can jump to it) instead of offering to start a second one. */
	paneByPage: Record<string, string>;
	setContact: (paneId: string, contact: string) => void;
	setBrief: (paneId: string, brief: string) => void;
	setNotes: (paneId: string, notes: string) => void;
	addLink: (paneId: string, url: string, name?: string) => void;
	removeLink: (paneId: string, url: string) => void;
	setHidden: (paneId: string, url: string, hidden: boolean) => void;
	setTitle: (paneId: string, title: string) => void;
	setSessionId: (paneId: string, sessionId: string) => void;
	setPaneForPage: (pageId: string, paneId: string) => void;
	/** Drop every entry for a pane that no longer exists (board "done" removes
	 *  the pane outright) — otherwise these localStorage maps only ever grow,
	 *  and a stale paneByPage makes a Notion task look like it still has a
	 *  session. */
	forgetPane: (paneId: string) => void;
}>()(
	persist(
		(set) => ({
			contactByPane: {},
			briefByPane: {},
			notesByPane: {},
			linksByPane: {},
			hiddenByPane: {},
			titleByPane: {},
			sessionIdByPane: {},
			paneByPage: {},
			setContact: (paneId, contact) =>
				set((s) => ({
					contactByPane: { ...s.contactByPane, [paneId]: contact },
				})),
			setBrief: (paneId, brief) =>
				set((s) => ({
					briefByPane: { ...s.briefByPane, [paneId]: brief },
				})),
			setNotes: (paneId, notes) =>
				set((s) => {
					// Empty note = no note: keep the map free of "" entries so a
					// cleared box doesn't outlive itself in localStorage.
					if (!notes.trim()) {
						const { [paneId]: _, ...rest } = s.notesByPane;
						return { notesByPane: rest };
					}
					return { notesByPane: { ...s.notesByPane, [paneId]: notes } };
				}),
			addLink: (paneId, url, name) =>
				set((s) => {
					// Re-adding a link replaces it, so that's how you rename one.
					const links = (s.linksByPane[paneId] ?? []).filter(
						(l) => linkUrl(l) !== url,
					);
					const link: BriefLink = name ? { url, name } : { url };
					return {
						linksByPane: { ...s.linksByPane, [paneId]: [...links, link] },
					};
				}),
			removeLink: (paneId, url) =>
				set((s) => {
					const links = (s.linksByPane[paneId] ?? []).filter(
						(l) => linkUrl(l) !== url,
					);
					const { [paneId]: _, ...rest } = s.linksByPane;
					// A removed link shouldn't come back hidden if you re-add it.
					const hidden = (s.hiddenByPane[paneId] ?? []).filter(
						(u) => u !== url,
					);
					const { [paneId]: __, ...hiddenRest } = s.hiddenByPane;
					return {
						linksByPane: links.length ? { ...rest, [paneId]: links } : rest,
						hiddenByPane: hidden.length
							? { ...hiddenRest, [paneId]: hidden }
							: hiddenRest,
					};
				}),
			setHidden: (paneId, url, hidden) =>
				set((s) => {
					const urls = (s.hiddenByPane[paneId] ?? []).filter((u) => u !== url);
					if (hidden) urls.push(url);
					const { [paneId]: _, ...rest } = s.hiddenByPane;
					return {
						hiddenByPane: urls.length ? { ...rest, [paneId]: urls } : rest,
					};
				}),
			setTitle: (paneId, title) =>
				set((s) => ({
					titleByPane: { ...s.titleByPane, [paneId]: title },
				})),
			setSessionId: (paneId, sessionId) =>
				set((s) => ({
					sessionIdByPane: { ...s.sessionIdByPane, [paneId]: sessionId },
				})),
			setPaneForPage: (pageId, paneId) =>
				set((s) => ({
					paneByPage: { ...s.paneByPage, [pageId]: paneId },
				})),
			forgetPane: (paneId) =>
				set((s) => {
					const drop = <T>(map: Record<string, T>) => {
						const { [paneId]: _, ...rest } = map;
						return rest;
					};
					return {
						contactByPane: drop(s.contactByPane),
						briefByPane: drop(s.briefByPane),
						notesByPane: drop(s.notesByPane),
						linksByPane: drop(s.linksByPane),
						hiddenByPane: drop(s.hiddenByPane),
						titleByPane: drop(s.titleByPane),
						sessionIdByPane: drop(s.sessionIdByPane),
						paneByPage: Object.fromEntries(
							Object.entries(s.paneByPage).filter(([, id]) => id !== paneId),
						),
					};
				}),
		}),
		{ name: "odin-pane-meta" },
	),
);
