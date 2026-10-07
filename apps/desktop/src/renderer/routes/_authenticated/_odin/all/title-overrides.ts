import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Your own name for a task, keyed by row key. Local only: a Slack message or a
 * Jira ticket can't be renamed upstream, so the new name lives here and every
 * Tasks row, search and session start reads it. An empty name clears it.
 */
export const useTitleOverrides = create<{
	titles: Record<string, string>;
	rename: (key: string, title: string) => void;
}>()(
	persist(
		(set) => ({
			titles: {},
			rename: (key, title) =>
				set((s) => {
					const { [key]: _old, ...rest } = s.titles;
					const titles = title ? { ...rest, [key]: title } : rest;
					// ponytail: keep the newest 500 names - done rows never clear theirs.
					return {
						titles: Object.fromEntries(Object.entries(titles).slice(-500)),
					};
				}),
		}),
		{ name: "odin-task-titles" },
	),
);
