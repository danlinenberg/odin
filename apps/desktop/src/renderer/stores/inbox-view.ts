import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * EXPERIMENT: the board's Inbox view (every open action item across sessions).
 * Off by default - the Board (kanban) is the view. Turned on in Settings >
 * Experimental, it adds the Inbox button to the view toggle.
 */
export const useInboxViewStore = create<{
	enabled: boolean;
	setEnabled: (enabled: boolean) => void;
}>()(
	persist(
		(set) => ({ enabled: false, setEnabled: (enabled) => set({ enabled }) }),
		{ name: "inbox-view" },
	),
);
