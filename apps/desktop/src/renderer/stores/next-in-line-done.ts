import {
	dayOf,
	isDue,
} from "renderer/routes/_authenticated/_odin/components/Reminders";
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

/**
 * Whether a task marked done at `doneAt` is still done. "Remind me" is a Done
 * with a reminder dated after the day it was marked: once that day comes the
 * task is back. A plain Done on an already-due task stays done — its date
 * isn't after the day it was finished.
 */
export function stillDone(
	doneAt: number | undefined,
	due: string | undefined,
	now: number,
): boolean {
	if (!doneAt) return false;
	return !(due && due > dayOf(doneAt) && isDue(due, now));
}
