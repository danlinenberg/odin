import { cn } from "@odin/ui/utils";
import { keepPreviousData } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { LuSettings2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import { allItems } from "../all/all-items";
import { useStartAllItem } from "../all/use-start-item";
import { FEED_TABS } from "../components/feed-counts";
import {
	HiddenToggle,
	HideButton,
	useHiddenFilter,
} from "../components/HiddenItems";
import { effectiveDue, useReminders } from "../components/Reminders";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";

const ICON = Object.fromEntries(FEED_TABS.map(({ to, Icon }) => [to, Icon]));

/**
 * The recommended queue: tasks from every feed that nobody has started yet —
 * no session on the board, idle or otherwise — ordered by importance by a
 * model (`rankNextInLine`) — feed order, marked unranked, until it answers. Click
 * Start to launch its session, same as All's Start button. A board column,
 * but not a status: nothing lands here or leaves by drag.
 */
export function NextInLine() {
	const { reactions, jira, pulls, notion } = useOdinFeeds();
	// todos, not tasks: automations run themselves, they're never next.
	const { todos } = useMyTasks();
	const reminders = useReminders((s) => s.reminders);
	const prompt = useNextInLinePrompt((s) => s.prompt);
	const navigate = useNavigate();
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
	// Same key the feeds hide under, so hiding here hides it there and back.
	const hide = useHiddenFilter("", rows, (item) => item.key);
	// ponytail: every row rendered — a few hundred plain cards scroll fine.
	// Window it (render on scroll) if the feeds ever reach thousands.
	// Every row goes to the model, hidden and started ones too: that input only
	// changes when a feed does, so hiding a card doesn't cost a re-rank.
	const rankInput = useMemo(
		() => ({
			items: rows.map((item) => ({
				key: item.key,
				title: item.title,
				source: item.source,
				priority: item.priority,
				person: item.person,
				context: item.context,
				due: effectiveDue(item.key, reminders, item.dueDate),
				ageDays: item.at
					? Math.floor((Date.now() - item.at) / 86_400_000)
					: null,
			})),
			instructions: prompt || undefined,
		}),
		[rows, reminders, prompt],
	);
	const ranking = electronTrpc.backlogReview.rankNextInLine.useQuery(
		rankInput,
		{
			enabled: rows.length > 1,
			staleTime: Number.POSITIVE_INFINITY,
			retry: false,
			// A feed refetch re-ranks; keep the last order on screen meanwhile.
			placeholderData: keepPreviousData,
		},
	);
	// The model's order, nothing else. Until it answers (or if it fails) the
	// column stays in feed order and says so — no rule of ours stands in.
	const candidates = hide.rows.filter((item) => !livePaneFor(item));
	const order = new Map(ranking.data?.keys.map((key, i) => [key, i]));
	// Stable sort: a row the model hasn't seen yet (arrived since) goes last.
	const next = order.size
		? candidates.toSorted(
				(a, b) =>
					(order.get(a.key) ?? order.size) - (order.get(b.key) ?? order.size),
			)
		: candidates;

	return (
		<div className="flex min-w-[240px] flex-1 flex-col rounded-xl border border-[#25252e] bg-[#111114]">
			<div className="flex items-center gap-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-[.4px] text-[#a5a5b3]">
				<span className="size-2 rounded-full bg-[#a394ff]" />
				Next in line
				<span
					className="text-[10px] font-normal normal-case tracking-normal text-[#8a8a97]"
					title={
						ranking.error
							? `AI ranking failed, so this is feed order — ${ranking.error.message}`
							: "Ordered by importance by claude (haiku)"
					}
				>
					{ranking.isFetching
						? "ranking…"
						: ranking.error
							? "unranked"
							: ranking.data
								? "AI"
								: "unranked"}
				</span>
				<span className="ml-auto flex items-center gap-2">
					<button
						type="button"
						onClick={() => navigate({ to: "/settings/board" })}
						title={
							prompt
								? "Sorted your way — edit how in Settings"
								: "Tell the AI how to sort these, in Settings"
						}
						className={
							prompt
								? "text-[#a394ff] hover:text-[#f5f5f7]"
								: "text-[#8a8a97] hover:text-[#f5f5f7]"
						}
					>
						<LuSettings2 className="size-3.5" aria-hidden />
					</button>
					<HiddenToggle
						count={hide.hiddenCount}
						showing={hide.showHidden}
						onToggle={() => hide.setShowHidden(!hide.showHidden)}
						className="font-normal normal-case tracking-normal"
					/>
					<span className="rounded-[10px] bg-[#1f1f27] px-2 font-medium">
						{next.length}
					</span>
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
								className={cn(
									"rounded-[10px] border border-[#3a3360] bg-[#14131b] px-3 py-2.5",
									hide.isHidden(item) && "opacity-50",
								)}
							>
								<div className="flex items-start gap-2 text-[12.5px] font-semibold">
									<span className="text-[#8a8a97]">{index + 1}</span>
									<span className="min-w-0 flex-1 break-words">
										{emojify(item.title)}
									</span>
									<span className="-mr-2 -mt-1">
										<HideButton
											hidden={hide.isHidden(item)}
											onClick={() => hide.toggle(item)}
										/>
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
