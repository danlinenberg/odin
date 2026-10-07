import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Settings → Appearance, and the Terminal / Chat buttons in the drawer: show a
 * session as a chat (Claude desktop style) or as its terminal. Chat by default.
 */
export const useSessionView = create<{
	chat: boolean;
	setChat: (chat: boolean) => void;
}>()(
	persist((set) => ({ chat: true, setChat: (chat) => set({ chat }) }), {
		name: "odin-session-view",
	}),
);
