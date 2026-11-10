import { create } from "zustand";
import { useSessionView } from "./session-view";

/**
 * A to-do saved from a chat reply jumps back to it: My notes sets the target,
 * and that session's chat scrolls to the reply (loading earlier turns until it
 * is there) and clears it.
 */
export const useReplyJump = create<{
	byPane: Record<string, string>;
	jump: (paneId: string, replyId: string) => void;
	clear: (paneId: string) => void;
}>()((set) => ({
	byPane: {},
	jump: (paneId, replyId) => {
		// The reply is in the chat, not the terminal.
		useSessionView.getState().setChat(true);
		set((s) => ({ byPane: { ...s.byPane, [paneId]: replyId } }));
	},
	clear: (paneId) =>
		set((s) => {
			const { [paneId]: _, ...rest } = s.byPane;
			return { byPane: rest };
		}),
}));
