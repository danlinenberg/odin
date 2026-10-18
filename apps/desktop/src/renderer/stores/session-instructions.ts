import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SessionInstructionsState {
	/** Your own ending for every task prompt; null = Odin's default. */
	instructions: string | null;
	setInstructions: (instructions: string | null) => void;
}

/**
 * Settings → Advanced: the standing instructions at the end of every task
 * prompt (work in the workspace, the Shell, ACTION ITEMS).
 */
export const useSessionInstructions = create<SessionInstructionsState>()(
	persist(
		(set) => ({
			instructions: null,
			setInstructions: (instructions) => set({ instructions }),
		}),
		{ name: "odin-session-instructions" },
	),
);
