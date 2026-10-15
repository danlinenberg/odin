import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Enough to scroll back a few days; the oldest chat drops first. */
const KEEP = 20;

/** One raven conversation, enough to resume its Claude session. */
export interface CrowChat {
	sessionId: string;
	title: string;
	cwd: string;
	at: number;
}

/**
 * The raven's conversations, newest first, so New chat no longer loses one:
 * the panel lists them and a click resumes it. Saving one again moves it to
 * the top.
 */
export const useCrowChats = create<{
	chats: CrowChat[];
	save: (chat: CrowChat) => void;
	/** A chat you deleted, or whose transcript is gone from this Mac. */
	drop: (sessionId: string) => void;
}>()(
	persist(
		(set) => ({
			chats: [],
			save: (chat) =>
				set(({ chats }) => ({
					chats: [
						chat,
						...chats.filter((c) => c.sessionId !== chat.sessionId),
					].slice(0, KEEP),
				})),
			drop: (sessionId) =>
				set(({ chats }) => ({
					chats: chats.filter((c) => c.sessionId !== sessionId),
				})),
		}),
		{ name: "odin-crow-chats" },
	),
);
