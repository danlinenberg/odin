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
 * Start to launch its session, same as All's Start button. A board column,
 * but not a status: nothing lands here or leaves by drag.
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
	).slice(0, 10);

	return (
		<div className="flex min-w-[240px] flex-1 flex-col rounded-xl border border-[#25252e] bg-[#111114]">
			<div className="flex items-center gap-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-[.4px] text-[#a5a5b3]">
				<span className="size-2 rounded-full bg-[#a394ff]" />
				Next in line
				<span className="ml-auto rounded-[10px] bg-[#1f1f27] px-2 font-medium">
					{next.length}
				</span>
			</div>
			<div className="flex flex-col gap-2 overflow-y-auto px-2 pb-2.5">
				{next.length === 0 ? (
					<div className="px-2 py-6 text-center text-xs text-[#8a8a97]">
						Nothing waiting to start
					</div>
				) : (
					next.map((item, index) => {
						const Icon = ICON[item.to];
						return (
							<div
								key={item.key}
								className="rounded-[10px] border border-[#3a3360] bg-[#14131b] px-3 py-2.5"
							>
								<div className="flex items-start gap-2 text-[12.5px] font-semibold">
									<span className="text-[#8a8a97]">{index + 1}</span>
									<span className="min-w-0 flex-1 break-words">
										{emojify(item.title)}
									</span>
								</div>
								<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#a5a5b3]">
									{Icon && <Icon className="size-3 shrink-0" aria-hidden />}
									<span>{item.source}</span>
									{item.priority && <span>· {item.priority}</span>}
									{item.person && <span>· {item.person}</span>}
									<button
										type="button"
										disabled={isLaunching}
										onClick={() => void start(item)}
										title="Start an agent session on this task"
										className="ml-auto rounded-md bg-[#14301f] px-2 py-0.5 font-semibold text-[#3ecf8e] hover:bg-[#1a4029] disabled:opacity-60"
									>
										{launchingKey === item.launch.key ? "starting…" : "▶ Start"}
									</button>
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
