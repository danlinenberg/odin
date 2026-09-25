import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@odin/ui/hover-card";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
	LuCheck,
	LuExternalLink,
	LuLoaderCircle,
	LuSettings2,
	LuSparkles,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { useNextInLineDone } from "renderer/stores/next-in-line-done";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import type { AllItem } from "../all/all-items";
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

/**
 * A feed title as something to read: Slack's *bold* and ~strike~ markers
 * dropped (they arrive raw), whitespace collapsed. The full original is the
 * card's tooltip.
 */
function cleanTitle(title: string): string {
	return title.replace(/[*~]/g, "").replace(/\s+/g, " ").trim();
}

const ICON = Object.fromEntries(FEED_TABS.map(({ to, Icon }) => [to, Icon]));

/**
 * The recommended queue: tasks from every feed that nobody has started yet —
 * no session on the board, idle or otherwise — ordered by importance by a
 * model (`rankNextInLine`) — feed order, marked unranked, until it answers. Click
 * Start to launch its session, same as All's Start button. A board column,
 * but not a status: nothing lands here or leaves by drag.
 */
/**
 * The last finished ranking, with a fingerprint of every task it ranked and
 * the prompt it ranked them by. Two jobs: a renderer reload shows it straight
 * away, and — the one that matters — a task list it already covers doesn't go
 * back to the model. Marking a task done, hiding it, a PR merging: those only
 * REMOVE rows, and removing a row can't change how the rest rank against each
 * other. Only a new or changed task, or a new prompt, is worth a ~75s run.
 * One key, overwritten each time: a few hundred short entries.
 */
const LAST_RANKING_KEY = "odin-next-in-line-last-ranking";

interface SavedRanking {
	keys: string[];
	/** task key → fingerprint of what the model was shown for it */
	seen: Record<string, string>;
	prompt: string;
}

function loadSavedRanking(): SavedRanking | undefined {
	try {
		const saved = JSON.parse(localStorage.getItem(LAST_RANKING_KEY) ?? "null");
		return Array.isArray(saved?.keys) && saved.seen ? saved : undefined;
	} catch {
		return undefined;
	}
}

/** djb2 over what the model sees for a task — short enough to keep hundreds. */
function fingerprint(item: object): string {
	const text = JSON.stringify(item);
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
	return (h >>> 0).toString(36);
}

/**
 * The feed rows and their AI ranking. Called from the Odin layout as well as
 * the column, so the ranking runs in the background whether or not the column
 * is open — React Query shares the one query, and opening the column just
 * reads what's already there.
 */
export function useNextInLineRanking() {
	const { reactions, jira, pulls, notion } = useOdinFeeds();
	// todos, not tasks: automations run themselves, they're never next.
	const { todos } = useMyTasks();
	const reminders = useReminders((s) => s.reminders);
	const prompt = useNextInLinePrompt((s) => s.prompt);
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
	// The model's input must only change when the tasks do — the main process
	// caches a ranking on its exact text, and a changed input is a fresh ~75s
	// run. So: every row, hidden and started ones too (hiding a card isn't a
	// change); sorted by key, not by `at`, which is last activity and reshuffles
	// on every feed refetch; and no age, because `at` would make every comment
	// on any ticket a new input.
	const rankInput = useMemo(
		() => ({
			items: rows
				.map((item) => ({
					key: item.key,
					title: item.title,
					source: item.source,
					priority: item.priority,
					person: item.person,
					context: item.context,
					due: effectiveDue(item.key, reminders, item.dueDate),
					ageDays: null,
				}))
				.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
			instructions: prompt || undefined,
		}),
		[rows, reminders, prompt],
	);
	const [saved, setSaved] = useState(loadSavedRanking);
	const prints = useMemo(
		() => rankInput.items.map((item) => [item.key, fingerprint(item)] as const),
		[rankInput],
	);
	// Every task on the list is one the last ranking saw, unchanged, under the
	// same prompt → its order still stands; the model has nothing to add.
	const covered =
		!!saved &&
		saved.prompt === (prompt || "") &&
		prints.every(([key, print]) => saved.seen[key] === print);
	const query = electronTrpc.backlogReview.rankNextInLine.useQuery(rankInput, {
		enabled: rows.length > 1 && !covered,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		// A new task re-ranks; keep the last order on screen meanwhile —
		// including the one saved before a reload, which empties this cache.
		placeholderData: (previous) =>
			previous ?? (saved ? { keys: saved.keys } : undefined),
	});
	useEffect(() => {
		if (!query.data || query.isPlaceholderData || covered) return;
		const next: SavedRanking = {
			keys: query.data.keys,
			seen: Object.fromEntries(prints),
			prompt: prompt || "",
		};
		setSaved(next);
		try {
			localStorage.setItem(LAST_RANKING_KEY, JSON.stringify(next));
		} catch {}
	}, [query.data, query.isPlaceholderData, covered, prints, prompt]);
	const ranking = covered
		? { data: { keys: saved.keys }, isFetching: false, error: null }
		: {
				data: query.data,
				isFetching: query.isFetching,
				error: query.error ? { message: query.error.message } : null,
			};
	// Names this ranking for RankStatus's clock; the same tasks give the same name.
	const signature = useMemo(() => JSON.stringify(rankInput), [rankInput]);
	// A Slack row's title is the message cut to a line; the hover card wants
	// the whole thing, which only the feed's own row still has.
	const slackText = useMemo(
		() =>
			new Map((reactions.data?.rows ?? []).map((row) => [row.id, row.text])),
		[reactions.data],
	);
	return {
		rows,
		ranking,
		prompt,
		signature,
		slackText,
		refetchSlack: () => void reactions.refetch(),
	};
}

export function NextInLine() {
	const { rows, ranking, prompt, signature, slackText, refetchSlack } =
		useNextInLineRanking();
	const navigate = useNavigate();
	const { start, livePaneFor, isLaunching, launchingKey } =
		useStartAllItem(refetchSlack);
	// Same key the feeds hide under, so hiding here hides it there and back.
	const hide = useHiddenFilter("", rows, (item) => item.key);
	// Open hands the link to the OS: a Slack permalink goes through Slack's
	// own hand-off into the desktop app, everything else to the browser.
	const openUrl = electronTrpc.external.openUrl.useMutation();
	// Every external item a session was ever started on — the work ledger
	// keeps the row after the session ends or is Done'd, which is exactly
	// what "already picked up, not next" needs. Display-only: the ranking's
	// input doesn't change, so this never costs a re-rank.
	const { data: ledger } = electronTrpc.workLog.list.useQuery(
		{ limit: 1000 },
		{ refetchInterval: 60_000 },
	);
	const doneKeys = useNextInLineDone((s) => s.done);
	const setLocalDone = useNextInLineDone((s) => s.setDone);
	// Slack has a Done of its own (Odin-only, shared with the Slack feed); the
	// rest go in the local done list. The row leaves the column either way —
	// a done Slack row drops out of the feed, so the ranking input changes and
	// that one re-ranks; the local list is display-only.
	const slackDone = electronTrpc.slack.setDone.useMutation({
		onSettled: refetchSlack,
	});
	const markDone = (item: AllItem, done: boolean) => {
		if (item.source === "Slack")
			slackDone.mutate({ id: item.launch.key, done });
		else setLocalDone(item.key, done);
	};
	const doneWithUndo = (item: AllItem) => {
		markDone(item, true);
		toast.success(`Done — ${cleanTitle(item.title).slice(0, 60)}`, {
			action: { label: "Undo", onClick: () => markDone(item, false) },
		});
	};
	const startedKeys = useMemo(
		() => new Set((ledger ?? []).map((row) => row.externalId)),
		[ledger],
	);
	// ponytail: every row rendered — a few hundred plain cards scroll fine.
	// Window it (render on scroll) if the feeds ever reach thousands.
	// The model's order, nothing else. Until it answers (or if it fails) the
	// column stays in feed order and says so — no rule of ours stands in.
	const candidates = hide.rows.filter(
		(item) =>
			!livePaneFor(item) &&
			!startedKeys.has(item.launch.key) &&
			!doneKeys[item.key],
	);
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
			<RankStatus
				fetching={ranking.isFetching}
				signature={signature}
				ranked={order.size > 0}
				error={ranking.error?.message ?? null}
				count={next.length}
			/>
			<div className="flex flex-col gap-2 overflow-y-auto px-2 pb-2.5">
				{next.length === 0 ? (
					<div className="px-2 py-6 text-center text-xs text-[#8a8a97]">
						Nothing waiting to start
					</div>
				) : (
					next.map((item) => {
						const Icon = ICON[item.to];
						const meta = [item.person, item.context]
							.filter(Boolean)
							.join(" · ");
						return (
							<div
								key={item.key}
								className={cn(
									"group relative flex items-start gap-2 rounded-[10px] border border-[#2c2940] bg-[#14131b] px-2.5 py-2 transition-colors hover:border-[#3f3a63]",
									hide.isHidden(item) && "opacity-50",
								)}
							>
								{/* A to-do's checkbox, where a to-do's checkbox goes. */}
								<button
									type="button"
									onClick={() => doneWithUndo(item)}
									title="Mark done — take it off Next in line"
									aria-label="Mark done"
									className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-[#4a4a58] text-transparent transition-colors hover:border-[#3ecf8e] hover:bg-[#14301f] hover:text-[#3ecf8e]"
								>
									<LuCheck className="size-2.5" strokeWidth={3} aria-hidden />
								</button>
								{/* Title and meta get the card's whole width; the actions only
								    exist on hover, so they never cost a line of text. */}
								<HoverCard openDelay={400} closeDelay={80}>
									<HoverCardTrigger asChild>
										<div className="min-w-0 flex-1">
											{/* dir=auto keeps a Hebrew line's characters in order; text-left
											    keeps every card's text on the same edge. */}
											<span
												dir="auto"
												className="line-clamp-2 break-words text-left text-[12.5px] font-medium leading-[1.4] text-[#ececf1]"
											>
												{emojify(cleanTitle(item.title))}
											</span>
											<div className="mt-1 flex items-center gap-1.5 text-[11px] text-[#8a8a97]">
												{Icon && (
													<Icon className="size-3 shrink-0" aria-hidden />
												)}
												{item.priority && (
													<span
														className={cn(
															"shrink-0 font-medium",
															item.urgency === "high"
																? "text-[#f0a0ad]"
																: item.urgency === "medium"
																	? "text-[#e6c07b]"
																	: "text-[#8a8a97]",
														)}
													>
														{item.priority}
													</span>
												)}
												<span className="min-w-0 truncate">{meta}</span>
											</div>
										</div>
									</HoverCardTrigger>
									<HoverCardContent
										side="left"
										align="start"
										className="w-[360px] border-[#2c2940] bg-[#16151f] p-3"
									>
										<TaskHover
											item={item}
											text={
												item.source === "Slack"
													? (slackText.get(item.launch.key) ?? null)
													: item.source === "Tasks"
														? item.launch.description
														: null
											}
										/>
									</HoverCardContent>
								</HoverCard>
								<div
									className={cn(
										"absolute right-1.5 top-1.5 hidden items-center gap-0.5 rounded-lg border border-[#2c2940] bg-[#1a1824] p-0.5 shadow-lg group-focus-within:flex group-hover:flex",
										launchingKey === item.launch.key && "flex",
									)}
								>
									<HideButton
										hidden={hide.isHidden(item)}
										onClick={() => hide.toggle(item)}
									/>
									{item.url && /^https?:\/\//.test(item.url) && (
										<button
											type="button"
											onClick={() => item.url && openUrl.mutate(item.url)}
											title={
												item.source === "Slack"
													? "Open the thread in Slack"
													: "Open in your browser"
											}
											aria-label="Open"
											className="rounded-md p-1 text-[#a5a5b3] hover:bg-[#262433] hover:text-[#f5f5f7]"
										>
											<LuExternalLink className="size-3.5" aria-hidden />
										</button>
									)}
									<button
										type="button"
										disabled={isLaunching}
										onClick={() => void start(item)}
										title="Start an agent session on this task"
										className="rounded-md bg-[#14301f] px-2 py-0.5 text-[11px] font-semibold text-[#3ecf8e] hover:bg-[#1a4029] disabled:opacity-60"
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

/**
 * What a card's hover says: the task in full — the whole Slack message, not
 * the line it was cut to — and everything the card had to leave out.
 */
function TaskHover({ item, text }: { item: AllItem; text: string | null }) {
	const Icon = ICON[item.to];
	const facts = [
		item.priority,
		item.status,
		item.dueDate && `due ${item.dueDate}`,
	].filter(Boolean);
	const where = [item.person, item.context].filter(Boolean).join(" · ");
	return (
		<div className="space-y-2 text-[12px] leading-[1.5]">
			<div className="flex items-center gap-1.5 text-[11px] text-[#8a8a97]">
				{Icon && <Icon className="size-3 shrink-0" aria-hidden />}
				<span className="font-medium text-[#a5a5b3]">{item.source}</span>
				{facts.length > 0 && <span>· {facts.join(" · ")}</span>}
			</div>
			<p
				dir="auto"
				className="max-h-[260px] overflow-y-auto whitespace-pre-wrap break-words text-left font-medium text-[#ececf1]"
			>
				{emojify(cleanTitle(text?.trim() ? text : item.title).slice(0, 1500))}
			</p>
			{where && <div className="text-[11px] text-[#8a8a97]">{where}</div>}
		</div>
	);
}

/**
 * When each ranking started, by its input. Outside the component: opening a
 * session drawer unmounts the column, and a clock in component state restarted
 * at 0 on every close while the same ranking carried on in main.
 */
const RANK_STARTED = new Map<string, number>();

/**
 * Where the order came from, said out loud: a ranking takes about a minute and
 * the column is usable meanwhile, so "is this the AI's order yet?" needs an
 * answer you can't miss — a spinner and a clock while it runs.
 */
function RankStatus({
	fetching,
	signature,
	ranked,
	error,
	count,
}: {
	fetching: boolean;
	signature: string;
	ranked: boolean;
	error: string | null;
	count: number;
}) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!fetching) return;
		const tick = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(tick);
	}, [fetching]);
	if (fetching && !RANK_STARTED.has(signature))
		RANK_STARTED.set(signature, Date.now());
	if (!fetching) RANK_STARTED.delete(signature);
	const startedAt = RANK_STARTED.get(signature) ?? now;
	const secs = Math.max(0, Math.round((now - startedAt) / 1000));

	if (fetching)
		return (
			<div className="mx-2 mb-2 flex items-start gap-2 rounded-lg border border-[#3a3360] bg-[#1a1730] px-2.5 py-2 text-[11.5px] text-[#d8d2ff]">
				<LuLoaderCircle
					className="mt-px size-3.5 shrink-0 animate-spin text-[#a394ff]"
					aria-hidden
				/>
				<span>
					AI is ranking {count} tasks… {secs}s
					<span className="block text-[#8a8a97]">
						Usually about a minute.{" "}
						{ranked
							? "Showing the previous ranking until then."
							: "Showing feed order until then."}
					</span>
				</span>
			</div>
		);
	if (error)
		return (
			<div
				className="mx-2 mb-2 cursor-text select-text rounded-lg border border-[#5a2733] bg-[#1d1417] px-2.5 py-2 text-[11.5px] text-[#f0a0ad]"
				title={error}
			>
				Unranked — AI ranking failed, so this is feed order.
				<span className="block truncate text-[#8a8a97]">{error}</span>
			</div>
		);
	if (ranked)
		return (
			<div className="mx-2 mb-2 flex items-center gap-1.5 px-1 text-[11px] text-[#8a8a97]">
				<LuSparkles className="size-3 text-[#a394ff]" aria-hidden />
				Ranked by AI
			</div>
		);
	return null;
}
