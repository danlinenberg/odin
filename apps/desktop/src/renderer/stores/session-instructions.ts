import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SessionInstructionsState {
	/** Your own ending for every task prompt; null = Odin's default. */
	instructions: string | null;
	setInstructions: (instructions: string | null) => void;
}

/**
 * Settings → Sessions: the standing instructions at the end of every task
 * prompt (work in the workspace, the Shell, ACTION ITEMS).
 *
 * ponytail: renderer localStorage, like launch-limits - the prompt is built in
 * the renderer. null rather than a copy of the default, so a default that
 * changes in a later build reaches everyone who never edited it.
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
