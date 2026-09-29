import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Long past the point a feed still lists a task you finished. */
const KEEP_MS = 90 * 86_400_000;

/**
 * Tasks marked Done in Next in line that have no done of their own in Odin —
 * Jira, GitHub, Notion, my tasks. (Slack rows use slack.setDone instead.)
 * Odin-only: nothing is written back upstream. Keyed by the All-feed key,
 * pruned after KEEP_MS so it stays a few KB.
 */
export const useNextInLineDone = create<{
	done: Record<string, number>;
	setDone: (key: string, done: boolean) => void;
}>()(
	persist(
		(set) => ({
			done: {},
			setDone: (key, done) =>
				set((state) => {
					const now = Date.now();
					const next = Object.fromEntries(
						Object.entries(state.done).filter(
							([k, at]) => k !== key && now - at < KEEP_MS,
						),
					);
					if (done) next[key] = now;
					return { done: next };
				}),
		}),
		{ name: "odin-next-in-line-done" },
	),
);
