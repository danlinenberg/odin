import { create } from "zustand";

/**
 * A remote session's latest connect step this run, per pane. Kept outside the
 * chat view: the drawer swaps the live view for the ended one when the host
 * drops, and a remount would forget it was ever connected.
 */
export interface HostEvent {
	kind: "connecting" | "connected" | "disconnected" | "failed";
	at: number;
	/** Conversation rows when it happened: "Connected" folds away once more arrive. */
	items: number;
}

export const useHostEvents = create<{
	byPane: Record<string, HostEvent>;
	mark: (paneId: string, kind: HostEvent["kind"], items: number) => void;
}>()((set) => ({
	byPane: {},
	mark: (paneId, kind, items) =>
		set((state) =>
			state.byPane[paneId]?.kind === kind
				? state
				: {
						byPane: {
							...state.byPane,
							[paneId]: { kind, at: Date.now(), items },
						},
					},
		),
}));
