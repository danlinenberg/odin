import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Settings → Sessions, and the drawer's Chat toggle: show a live session as a
 * chat (Claude desktop style) instead of its terminal. One flag for both, so
 * flipping it in the drawer is the setting.
 */
export const useSessionView = create<{
	chat: boolean;
	setChat: (chat: boolean) => void;
}>()(
	persist((set) => ({ chat: false, setChat: (chat) => set({ chat }) }), {
		name: "odin-session-view",
	}),
);
