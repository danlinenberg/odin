import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Settings → Board's "how to sort Next in line": your own words, handed to the
 * model with every ranking. Empty = the model judges importance by itself.
 *
 * Renderer storage, same reason as launch-limits: the only reader is the
 * board, which sends it along in the ranking call.
 */
export const useNextInLinePrompt = create<{
	prompt: string;
	setPrompt: (prompt: string) => void;
	/** How long past its date a task still pins under Due. */
	pinOverdueDays: number;
	setPinOverdueDays: (days: number) => void;
}>()(
	persist(
		(set) => ({
			prompt: "",
			setPrompt: (prompt) => set({ prompt }),
			pinOverdueDays: 30,
			setPinOverdueDays: (pinOverdueDays) => set({ pinOverdueDays }),
		}),
		{ name: "odin-next-in-line-prompt" },
	),
);
