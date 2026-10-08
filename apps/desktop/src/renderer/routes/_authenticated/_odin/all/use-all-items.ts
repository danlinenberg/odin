import { useMemo } from "react";
import { doneChecker, useDoneStore } from "renderer/stores/done";
import { isClosedStatus } from "../components/search-all";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";
import { type AllItem, allItems } from "./all-items";
import { useTitleOverrides } from "./title-overrides";

/** Every feed through allItems, under your own names, plus the Done check. */
function useItems(everything: boolean) {
	const { reactions, jira, pulls, notion, emails } = useOdinFeeds();
	// todos, not tasks: automations have their own panel and run themselves -
	// they'd sit in "what have I got on" forever without ever being yours to do.
	const { todos } = useMyTasks();
	const done = useDoneStore((s) => s.done);
	const isDone = useMemo(() => doneChecker(done), [done]);
	const titles = useTitleOverrides((s) => s.titles);
	const items = useMemo(
		() =>
			allItems(
				{
					tasks: todos,
					slack: reactions.data?.rows ?? [],
					jira: jira.data?.issues ?? [],
					pulls: pulls.data?.pulls ?? [],
					notion: notion.data?.rows ?? [],
					emails: emails.data?.emails ?? [],
				},
				{ everything },
			).map((item) =>
				titles[item.key] ? { ...item, title: titles[item.key] } : item,
			),
		[
			everything,
			titles,
			todos,
			reactions.data,
			jira.data,
			pulls.data,
			notion.data,
			emails.data,
		],
	);
	return { items, isDone };
}

/** The All feed's rows: every source, minus what's Done. */
export function useAllItems(): AllItem[] {
	const { items, isDone } = useItems(false);
	return useMemo(() => items.filter((item) => !isDone(item)), [items, isDone]);
}

/**
 * What Search all looks through: every row any feed holds, All's exclusions
 * and Done'd rows included, each marked `done` when it's Done'd in Odin or
 * closed upstream so it can rank below the open ones.
 */
export function useSearchableItems(): (AllItem & { done: boolean })[] {
	const { items, isDone } = useItems(true);
	return useMemo(
		() =>
			items.map((item) => ({
				...item,
				done: isDone(item) || isClosedStatus(item.status),
			})),
		[items, isDone],
	);
}
