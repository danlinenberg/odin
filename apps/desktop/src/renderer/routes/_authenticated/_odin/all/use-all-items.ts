import { useMemo } from "react";
import { doneChecker, useDoneStore } from "renderer/stores/done";
import { isClosedStatus } from "../components/search-all";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";
import { type AllItem, allItems, urgencyOf } from "./all-items";
import { useTitleOverrides } from "./title-overrides";

/** Every feed through allItems, under your own names, plus the Done check. */
function useItems(everything: boolean) {
	const { reactions, jira, pulls, notion, emails, clickup } = useOdinFeeds();
	// todos, not tasks: automations have their own panel and run themselves -
	// they'd sit in "what have I got on" forever without ever being yours to do.
	const { todos } = useMyTasks();
	const done = useDoneStore((s) => s.done);
	const isDone = useMemo(() => doneChecker(done), [done]);
	const titles = useTitleOverrides((s) => s.titles);
	const priorities = useTitleOverrides((s) => s.priorities);
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
					clickup: clickup.data?.tasks ?? [],
				},
				{ everything },
			).map((item) => {
				const title = titles[item.key];
				const priority = priorities[item.key];
				if (!title && !priority) return item;
				return {
					...item,
					...(title ? { title } : {}),
					...(priority
						? {
								priority,
								urgency: urgencyOf(priority),
								sourcePriority: item.priority,
							}
						: {}),
				};
			}),
		[
			everything,
			titles,
			priorities,
			todos,
			reactions.data,
			jira.data,
			pulls.data,
			notion.data,
			emails.data,
			clickup.data,
		],
	);
	return { items, isDone, done };
}

/**
 * The All feed's rows: every source, minus what's Done. Read later is a
 * Done too - it lists under Docs.
 */
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

type FeedInput = Parameters<typeof allItems>[0];

/**
 * One feed's rows as table rows, keyed like All's - for a feed tab that keeps
 * its own filters and grouping but draws every row with All's table.
 * Everything the feed holds, under your own names and priorities.
 */
export function useFeedItems(input: Partial<FeedInput>): Map<string, AllItem> {
	const titles = useTitleOverrides((s) => s.titles);
	const priorities = useTitleOverrides((s) => s.priorities);
	const { tasks, slack, jira, pulls, notion, emails, clickup } = input;
	return useMemo(() => {
		const items = allItems(
			{
				tasks: tasks ?? [],
				slack: slack ?? [],
				jira: jira ?? [],
				pulls: pulls ?? [],
				notion: notion ?? [],
				emails: emails ?? [],
				clickup: clickup ?? [],
			},
			{ everything: true },
		);
		return new Map(
			items.map((item) => {
				const title = titles[item.key];
				const priority = priorities[item.key];
				return [
					item.key,
					{
						...item,
						...(title ? { title } : {}),
						...(priority
							? {
									priority,
									urgency: urgencyOf(priority),
									sourcePriority: item.priority,
								}
							: {}),
					},
				];
			}),
		);
	}, [titles, priorities, tasks, slack, jira, pulls, notion, emails, clickup]);
}
