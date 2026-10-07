import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Settings → Sessions: show a live session as a chat (Claude desktop style)
 * instead of its terminal.
 */
export const useSessionView = create<{
	chat: boolean;
	setChat: (chat: boolean) => void;
}>()(
	persist((set) => ({ chat: false, setChat: (chat) => set({ chat }) }), {
		name: "odin-session-view",
	}),
);
