import { useMemo } from "react";
import { doneChecker, useDoneStore } from "renderer/stores/done";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";
import { type AllItem, allItems } from "./all-items";
import { useTitleOverrides } from "./title-overrides";

/**
 * The All feed's rows: every source through allItems, minus what's Done, under
 * your own names. Search all reads the same list, so it can't find a row All
 * wouldn't show.
 */
export function useAllItems(): AllItem[] {
	const { reactions, jira, pulls, notion, emails } = useOdinFeeds();
	// todos, not tasks: automations have their own panel and run themselves -
	// they'd sit in "what have I got on" forever without ever being yours to do.
	const { todos } = useMyTasks();
	const done = useDoneStore((s) => s.done);
	const isDone = useMemo(() => doneChecker(done), [done]);
	const titles = useTitleOverrides((s) => s.titles);
	return useMemo(
		() =>
			allItems({
				tasks: todos,
				slack: reactions.data?.rows ?? [],
				jira: jira.data?.issues ?? [],
				pulls: pulls.data?.pulls ?? [],
				notion: notion.data?.rows ?? [],
				emails: emails.data?.emails ?? [],
			})
				.filter((item) => !isDone(item))
				.map((item) =>
					titles[item.key] ? { ...item, title: titles[item.key] } : item,
				),
		[
			titles,
			todos,
			reactions.data,
			jira.data,
			pulls.data,
			notion.data,
			emails.data,
			isDone,
		],
	);
}
