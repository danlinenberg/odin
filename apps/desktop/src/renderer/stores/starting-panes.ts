import { create } from "zustand";

/**
 * Panes whose session is between its card appearing and its PTY coming up.
 *
 * A launch puts the card on the board first and does the slow part behind it
 * - the git worktree, the prompt file, the launch gate, the PTY spawn - which
 * takes seconds. In that window the pane has no PTY and an idle status, which
 * is exactly what a session that ended looks like, so without this flag the
 * board would offer Resume on a session that hasn't started. Not persisted:
 * a launch that dies with the app leaves nothing to clear.
 */
export const useStartingPanes = create<{
	ids: string[];
	add: (paneId: string) => void;
	remove: (paneId: string) => void;
}>((set) => ({
	ids: [],
	add: (paneId) =>
		set((state) =>
			state.ids.includes(paneId) ? state : { ids: [...state.ids, paneId] },
		),
	remove: (paneId) =>
		set((state) =>
			state.ids.includes(paneId)
				? { ids: state.ids.filter((id) => id !== paneId) }
				: state,
		),
}));
