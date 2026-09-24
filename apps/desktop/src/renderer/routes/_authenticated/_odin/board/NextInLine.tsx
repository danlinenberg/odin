import { useMemo } from "react";
import { emojify } from "renderer/lib/emoji";
import { allItems, rankNext } from "../all/all-items";
import { useStartAllItem } from "../all/use-start-item";
import { FEED_TABS } from "../components/feed-counts";
import { useHiddenFilter } from "../components/HiddenItems";
import { effectiveDue, isDue, useReminders } from "../components/Reminders";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";

const ICON = Object.fromEntries(FEED_TABS.map(({ to, Icon }) => [to, Icon]));

/**
 * The recommended queue: tasks from every feed that nobody has started yet —
 * no session on the board, idle or otherwise — ranked by `rankNext`. Click one
 * to start its session, same as All's Start button.
 */
export function NextInLine() {
	const { reactions, jira, pulls, notion } = useOdinFeeds();
	// todos, not tasks: automations run themselves, they're never next.
	const { todos } = useMyTasks();
	const reminders = useReminders((s) => s.reminders);
	const { start, livePaneFor, isLaunching, launchingKey } = useStartAllItem(
		() => void reactions.refetch(),
	);
	const rows = useMemo(
		() =>
			allItems({
				tasks: todos,
				slack: reactions.data?.rows ?? [],
				jira: jira.data?.issues ?? [],
				pulls: pulls.data?.pulls ?? [],
				notion: notion.data?.rows ?? [],
			}),
		[todos, reactions.data, jira.data, pulls.data, notion.data],
	);
	// Same key the feeds hide under, so a row you hid there stays hidden here.
	const visible = useHiddenFilter("", rows, (item) => item.key).rows;
	const next = rankNext(
		visible.filter((item) => !livePaneFor(item)),
		(item) =>
			isDue(effectiveDue(item.key, reminders, item.dueDate), Date.now()),
	).slice(0, 5);

	return (
		<div className="mx-[18px] mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-[#25252e] bg-[#111114] px-3 py-2">
			<span className="mr-1 text-xs font-semibold uppercase tracking-[.4px] text-[#a5a5b3]">
				Next in line
			</span>
			{next.length === 0 ? (
				<span className="text-xs text-[#8a8a97]">Nothing waiting to start</span>
			) : (
				next.map((item, index) => {
					const Icon = ICON[item.to];
					return (
						<button
							key={item.key}
							type="button"
							disabled={isLaunching}
							onClick={() => void start(item)}
							title={`Start a session — ${item.source}${item.priority ? ` · ${item.priority}` : ""}`}
							className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-[#25252e] bg-[#16161b] px-2 py-1 text-[12px] text-[#f5f5f7] hover:border-[#34343f] disabled:opacity-60"
						>
							<span className="text-[#8a8a97]">{index + 1}</span>
							{Icon && (
								<Icon className="size-3 shrink-0 text-[#a5a5b3]" aria-hidden />
							)}
							<span className="truncate">
								{launchingKey === item.launch.key
									? "starting…"
									: emojify(item.title)}
							</span>
						</button>
					);
				})
			)}
		</div>
	);
}
