import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Settings → Appearance, and the Terminal / Chat buttons in the drawer: show a
 * session as a chat (Claude desktop style) or as its terminal. Chat by default.
 * `commands` opens every "Worked" group in the chat, so you see each command
 * Claude ran without clicking. Off by default.
 */
export const useSessionView = create<{
	chat: boolean;
	setChat: (chat: boolean) => void;
	commands: boolean;
	setCommands: (commands: boolean) => void;
}>()(
	persist(
		(set) => ({
			chat: true,
			setChat: (chat) => set({ chat }),
			commands: false,
			setCommands: (commands) => set({ commands }),
		}),
		{ name: "odin-session-view" },
	),
);
