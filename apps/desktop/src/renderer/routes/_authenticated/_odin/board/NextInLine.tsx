import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@odin/ui/hover-card";
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
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import { create } from "zustand";
import type { AllItem } from "../all/all-items";
import { allItems } from "../all/all-items";
import { useStartAllItem } from "../all/use-start-item";
import { FEED_TABS } from "../components/feed-counts";
import {
	DueChip,
	dayOf,
	effectiveDue,
	useReminders,
} from "../components/Reminders";
import { useBacklogReview } from "../hooks/useBacklogReview";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";
import type { SweptRow } from "../review/verdicts";

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
 * no session on the board, idle or otherwise — in All tasks order, until you
 * apply the model's (`rankNextInLine`) order and hides. Click
 * Start to launch its session, same as All's Start button. A board column,
 * but not a status: nothing lands here or leaves by drag.
 */
/**
 * The last ranking you asked for, kept so a reload still shows it. One key,
 * overwritten each time: a few hundred short entries.
 */
const LAST_RANKING_KEY = "odin-next-in-line-last-ranking";
/** Whether the AI's order and hides are on, or the column is All tasks order. */
const APPLIED_KEY = "odin-next-in-line-applied";

interface Ranking {
	keys: string[];
	hidden: string[];
}

function loadSaved(): Ranking | undefined {
	try {
		const saved = JSON.parse(localStorage.getItem(LAST_RANKING_KEY) ?? "null");
		return Array.isArray(saved?.keys) && Array.isArray(saved.hidden)
			? { keys: saved.keys, hidden: saved.hidden }
			: undefined;
	} catch {
		return undefined;
	}
}

function loadApplied(): boolean {
	try {
		return localStorage.getItem(APPLIED_KEY) === "1";
	} catch {
		return false;
	}
}

/**
 * The AI's recommendation, and whether it's applied. A store, not component
 * state: a run outlives the column (a session drawer unmounts it), and the
 * answer still has to land.
 */
const useAiRanking = create<{
	ranking: Ranking | undefined;
	applied: boolean;
	startedAt: number | null;
	error: string | null;
}>(() => ({
	ranking: loadSaved(),
	applied: loadApplied(),
	startedAt: null,
	error: null,
}));

function setApplied(on: boolean) {
	useAiRanking.setState({ applied: on });
	try {
		localStorage.setItem(APPLIED_KEY, on ? "1" : "0");
	} catch {}
}

type RankInput = Parameters<
	typeof electronTrpcClient.backlogReview.rankNextInLine.query
>[0];

/**
 * One fresh run on the tasks as they are now — no cache on either side — then
 * its order and hides go on. Only ever from the Apply button: nothing ranks in
 * the background.
 */
async function applyAiRanking(input: RankInput) {
	if (useAiRanking.getState().startedAt) return;
	useAiRanking.setState({ startedAt: Date.now(), error: null });
	try {
		const ranking = await electronTrpcClient.backlogReview.rankNextInLine.query(
			{ ...input, fresh: true },
		);
		useAiRanking.setState({ ranking, startedAt: null });
		setApplied(true);
		try {
			localStorage.setItem(LAST_RANKING_KEY, JSON.stringify(ranking));
		} catch {}
	} catch (error) {
		useAiRanking.setState({
			startedAt: null,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** The feed rows, in All tasks order, and what the model is shown of them. */
function useNextInLineRows() {
	const { reactions, jira, pulls, notion } = useOdinFeeds();
	// todos, not tasks: automations run themselves, they're never next.
	const { todos } = useMyTasks();
	const reminders = useReminders((s) => s.reminders);
	const prompt = useNextInLinePrompt((s) => s.prompt);
	// The Review sweep's verdicts go to the model too, so instructions like
	// "DROPs last" have something to go on.
	const swept = useBacklogReview((s) => s.swept);
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
	// Built on click, not per render: in All tasks order (newest activity
	// first) with real ages, so "same order as All tasks" is something the
	// model can actually see.
	const rankInput = (items: AllItem[]): RankInput => {
		const verdicts = new Map(swept.map((row) => [row.key, row.verdict]));
		const now = Date.now();
		return {
			items: items.map((item) => ({
				key: item.key,
				title: item.title,
				source: item.source,
				priority: item.priority,
				person: item.person,
				context: item.context,
				due: effectiveDue(item.key, reminders, item.dueDate),
				ageDays: item.at ? Math.floor((now - item.at) / 86_400_000) : null,
				review: verdicts.get(item.key) ?? null,
			})),
			instructions: prompt || undefined,
		};
	};
	return {
		rows,
		reminders,
		prompt,
		rankInput,
		refetchSlack: () => void reactions.refetch(),
	};
}

export function NextInLine() {
	const { rows, reminders, prompt, rankInput, refetchSlack } =
		useNextInLineRows();
	const { ranking, applied, startedAt, error } = useAiRanking();
	const pinOverdueDays = useNextInLinePrompt((s) => s.pinOverdueDays);
	const navigate = useNavigate();
	const { start, livePaneFor, isLaunching, launchingKey } =
		useStartAllItem(refetchSlack);
	// The rows your instructions hide, per the model — revealed, dimmed, on ask.
	const [showHidden, setShowHidden] = useState(false);
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
	// Same Done as every feed, so a row done here is done there and back.
	const { isDone, markDone } = useDone();
	const doneWithUndo = (item: AllItem) =>
		markDone({ ...item, title: cleanTitle(item.title) });
	// The Review sweep's DROPs, so a row it wants gone says so here too. By key,
	// or by link for PRs, which Next in line keys by id and the sweep by repo#n.
	const swept = useBacklogReview((s) => s.swept);
	const dropFor = useMemo(() => {
		const drops = swept.filter((row) => row.verdict === "DROP");
		const byKey = new Map(drops.map((row) => [row.key, row]));
		const byUrl = new Map(
			drops.flatMap((row) => (row.url ? [[row.url, row] as const] : [])),
		);
		return (item: AllItem) =>
			byKey.get(item.key) ?? (item.url ? byUrl.get(item.url) : undefined);
	}, [swept]);
	// Every verdict, not just DROPs: the hover says what the sweep found either way.
	const sweptFor = useMemo(() => {
		const byKey = new Map(swept.map((row) => [row.key, row]));
		const byUrl = new Map(
			swept.flatMap((row) => (row.url ? [[row.url, row] as const] : [])),
		);
		return (item: AllItem) =>
			byKey.get(item.key) ?? (item.url ? byUrl.get(item.url) : undefined);
	}, [swept]);
	const startedKeys = useMemo(
		() => new Set((ledger ?? []).map((row) => row.externalId)),
		[ledger],
	);
	// ponytail: every row rendered — a few hundred plain cards scroll fine.
	// Window it (render on scroll) if the feeds ever reach thousands.
	// The model's order, nothing else. Until it answers (or if it fails) the
	// column stays in feed order and says so — no rule of ours stands in.
	const waiting = rows.filter(
		(item) =>
			!livePaneFor(item) && !startedKeys.has(item.launch.key) && !isDone(item),
	);
	// Rows your instructions say not to show, per the model. They count as
	// hidden and come back, dimmed, under the same "show hidden" as yours.
	const aiHidden = new Set(applied ? ranking?.hidden : []);
	const isAiHidden = (item: AllItem) => aiHidden.has(item.key);
	const aiHiddenCount = waiting.filter(isAiHidden).length;
	const candidates = showHidden
		? waiting
		: waiting.filter((item) => !isAiHidden(item));
	const order = new Map(applied ? ranking?.keys.map((key, i) => [key, i]) : []);
	// Stable sort: a row the model hasn't seen yet (arrived since) goes last.
	const next = order.size
		? candidates.toSorted(
				(a, b) =>
					(order.get(a.key) ?? order.size) - (order.get(b.key) ?? order.size),
			)
		: candidates;
	// Anything due, or overdue by up to a month, is pinned above the order,
	// soonest first — a deadline outranks whatever the model thinks. Older
	// than that it's a stale ticket's leftover, not a deadline: it stays put.
	// A rolling window, not the calendar year, so January keeps December's.
	// ponytail: every future date pins, however far out; add a horizon if a
	// month-away date starts crowding the top.
	const cutoff = dayOf(Date.now() - pinOverdueDays * 86_400_000);
	const dueOf = (item: AllItem) => {
		const due = effectiveDue(item.key, reminders, item.dueDate);
		return due && due >= cutoff ? due : null;
	};
	const pinned = next
		.filter((item) => dueOf(item))
		.toSorted((a, b) => (dueOf(a) ?? "").localeCompare(dueOf(b) ?? ""));
	const unpinned = pinned.length ? next.filter((item) => !dueOf(item)) : next;

	return (
		<div className="flex min-w-[240px] flex-1 flex-col rounded-xl border border-[#4b4380] bg-[#15131f] shadow-[0_0_0_1px_rgba(163,148,255,.12),0_8px_24px_-8px_rgba(163,148,255,.35)]">
			<div className="flex items-center gap-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-[.4px] text-[#d6d0ff]">
				<span className="size-2 rounded-full bg-[#a394ff] shadow-[0_0_6px_#a394ff]" />
				Next in line
				<span className="ml-auto flex items-center gap-2">
					<button
						type="button"
						onClick={() => navigate({ to: "/settings/next-in-line" })}
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
						count={aiHiddenCount}
						showing={showHidden}
						onToggle={() => setShowHidden(!showHidden)}
						className="font-normal normal-case tracking-normal"
					/>
					<span className="rounded-[10px] bg-[#2c2750] px-2 font-medium text-[#d6d0ff]">
						{next.length}
					</span>
				</span>
			</div>
			<RankStatus
				startedAt={startedAt}
				ranked={!!ranking?.keys.length}
				applied={applied}
				// Everything waiting, hidden rows too: what's hidden is the model's
				// call as much as the order is.
				onApply={() => void applyAiRanking(rankInput(waiting))}
				onUndo={() => setApplied(false)}
				error={error}
				count={waiting.length}
			/>
			<div className="flex flex-col gap-2 overflow-y-auto px-2 pb-2.5">
				{next.length === 0 ? (
					<div className="px-2 py-6 text-center text-xs text-[#8a8a97]">
						Nothing waiting to start
					</div>
				) : (
					<>
						{pinned.length > 0 && (
							<div className="px-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[.4px] text-[#e6c07b]">
								Due · {pinned.length}
							</div>
						)}
						{pinned.map((item) => card(item, true))}
						{pinned.length > 0 && unpinned.length > 0 && (
							<div className="mt-1 border-t border-[#2c2940] px-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
								Everything else
							</div>
						)}
						{unpinned.map((item) => card(item, false))}
					</>
				)}
			</div>
		</div>
	);

	function card(item: AllItem, due: boolean) {
		const Icon = ICON[item.to];
		const meta = [item.person, item.context].filter(Boolean).join(" · ");
		return (
			<div
				key={item.key}
				className={cn(
					"group relative flex items-start gap-2 rounded-[10px] border border-[#2c2940] bg-[#14131b] px-2.5 py-2 transition-colors hover:border-[#3f3a63]",
					isAiHidden(item) && "opacity-50",
				)}
				title={
					isAiHidden(item)
						? "Hidden by your Next in line instructions"
						: undefined
				}
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
								{Icon && <Icon className="size-3 shrink-0" aria-hidden />}
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
								{due && (
									<span className="ml-auto shrink-0">
										<DueChip
											itemKey={item.key}
											title={item.title}
											upstream={item.dueDate}
										/>
									</span>
								)}
							</div>
							{dropFor(item) && (
								<div
									title={`The Review sweep says drop this: ${dropFor(item)?.evidence}`}
									className="mt-1 line-clamp-2 rounded-[5px] bg-[#331a1f] px-[7px] py-px text-[11px] font-medium text-[#ff7a8a]"
								>
									Drop? {dropFor(item)?.evidence}
								</div>
							)}
						</div>
					</HoverCardTrigger>
					<HoverCardContent
						side="left"
						align="start"
						className="w-[440px] border-[#2c2940] bg-[#16151f] p-3"
					>
						<TaskHover
							item={item}
							swept={sweptFor(item)}
							rank={applied ? order.get(item.key) : undefined}
							due={effectiveDue(item.key, reminders, item.dueDate)}
						/>
					</HoverCardContent>
				</HoverCard>
				<div
					className={cn(
						"absolute right-1.5 top-1.5 hidden items-center gap-0.5 rounded-lg border border-[#2c2940] bg-[#1a1824] p-0.5 shadow-lg group-focus-within:flex group-hover:flex",
						launchingKey === item.launch.key && "flex",
					)}
				>
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
	}
}

/**
 * What a card's hover says: the task in full — the whole Slack message, not
 * the line it was cut to — and everything the card had to leave out: every
 * field the source sent, the comment that put it here, what the Review sweep
 * found, where the AI ranked it, and the link itself.
 */
function TaskHover({
	item,
	swept,
	rank,
	due,
}: {
	item: AllItem;
	swept: SweptRow | undefined;
	rank: number | undefined;
	due: string | null;
}) {
	const Icon = ICON[item.to];
	const rows: [string, string][] = [...item.details];
	if (due && !rows.some(([label]) => label === "Due")) rows.push(["Due", due]);
	if (rank !== undefined) rows.push(["AI rank", `#${rank + 1}`]);
	const body = item.body?.trim();
	return (
		<div className="space-y-2.5 text-[12px] leading-[1.5]">
			<div className="flex items-center gap-1.5 text-[11px] text-[#8a8a97]">
				{Icon && <Icon className="size-3 shrink-0" aria-hidden />}
				<span className="font-medium text-[#a5a5b3]">{item.source}</span>
				{item.priority && <span>· {item.priority}</span>}
				{item.status && <span>· {item.status}</span>}
			</div>
			<p
				dir="auto"
				className="break-words text-left font-semibold text-[#ececf1]"
			>
				{emojify(cleanTitle(item.title))}
			</p>
			{body && body !== item.title.trim() && (
				<p
					dir="auto"
					className="max-h-[220px] cursor-text select-text overflow-y-auto whitespace-pre-wrap break-words text-left text-[#c9c9d3]"
				>
					{emojify(body.slice(0, 3000))}
				</p>
			)}
			{item.mention && (
				<div className="rounded-md border-l-2 border-[#a394ff] bg-[#1d1a2e] px-2 py-1.5 text-[#c9c9d3]">
					{item.mention.author && (
						<div className="text-[11px] font-medium text-[#a394ff]">
							{item.mention.author}
						</div>
					)}
					<div
						dir="auto"
						className="line-clamp-6 whitespace-pre-wrap break-words"
					>
						{emojify(item.mention.text)}
					</div>
				</div>
			)}
			{rows.length > 0 && (
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
					{rows.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-[#8a8a97]">{label}</dt>
							<dd dir="auto" className="min-w-0 break-words text-[#d6d6de]">
								{value}
							</dd>
						</div>
					))}
				</dl>
			)}
			{swept && (
				<div
					className={cn(
						"rounded-md px-2 py-1.5 text-[11.5px]",
						swept.verdict === "DROP"
							? "bg-[#331a1f] text-[#ff9aa6]"
							: "bg-[#1b1f2a] text-[#b8c0d4]",
					)}
				>
					<span className="font-semibold">Review sweep: {swept.verdict}</span>
					{swept.evidence && ` — ${swept.evidence}`}
				</div>
			)}
			{item.url && (
				<div className="cursor-text select-text truncate text-[11px] text-[#6f6f80]">
					{item.url}
				</div>
			)}
		</div>
	);
}

/**
 * Where the order came from, said out loud, and the one control over it:
 * All tasks order until you apply the AI's, which runs fresh on the spot.
 */
function RankStatus({
	startedAt,
	ranked,
	applied,
	onApply,
	onUndo,
	error,
	count,
}: {
	startedAt: number | null;
	ranked: boolean;
	applied: boolean;
	onApply: () => void;
	onUndo: () => void;
	error: string | null;
	count: number;
}) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!startedAt) return;
		const tick = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(tick);
	}, [startedAt]);

	if (startedAt)
		return (
			<div className="mx-2 mb-2 flex items-start gap-2 rounded-lg border border-[#3a3360] bg-[#1a1730] px-2.5 py-2 text-[11.5px] text-[#d8d2ff]">
				<LuLoaderCircle
					className="mt-px size-3.5 shrink-0 animate-spin text-[#a394ff]"
					aria-hidden
				/>
				<span>
					AI is ranking {count} tasks…{" "}
					{Math.max(0, Math.round((now - startedAt) / 1000))}s
					<span className="block text-[#8a8a97]">
						Usually about 20 seconds. Applies when it's done.
					</span>
				</span>
			</div>
		);
	const button = (
		<button
			type="button"
			onClick={onApply}
			title="Rank these now, from scratch, and use the AI's order and hides"
			className="ml-auto flex shrink-0 items-center gap-1 rounded-md bg-[#2c2750] px-2 py-0.5 font-medium text-[#d6d0ff] hover:bg-[#3a3366]"
		>
			<LuSparkles className="size-3 text-[#a394ff]" aria-hidden />
			{applied && ranked ? "Re-rank" : "Apply AI recommendations"}
		</button>
	);
	return (
		<div className="mx-2 mb-2 px-1 text-[11px] text-[#8a8a97]">
			<div className="flex items-center gap-1.5">
				{applied && ranked ? (
					<>
						<LuSparkles className="size-3 text-[#a394ff]" aria-hidden />
						Ranked by AI
						<button
							type="button"
							onClick={onUndo}
							className="hover:text-[#f5f5f7]"
						>
							· back to All tasks order
						</button>
					</>
				) : (
					"All tasks order"
				)}
				{button}
			</div>
			{error && (
				<div
					className="mt-1 cursor-text select-text truncate text-[#f0a0ad]"
					title={error}
				>
					AI ranking failed: {error}
				</div>
			)}
		</div>
	);
}

/** "show hidden (N)" — the rows your instructions hide, never without a way back. */
function HiddenToggle({
	count,
	showing,
	onToggle,
	className,
}: {
	count: number;
	showing: boolean;
	onToggle: () => void;
	className?: string;
}) {
	if (count === 0 && !showing) return null;
	return (
		<button
			type="button"
			onClick={onToggle}
			className={cn(
				"text-[12px] text-[#8a8a97] transition-colors hover:text-[#a5a5b3]",
				className,
			)}
		>
			{showing ? "hide" : "show"} hidden ({count})
		</button>
	);
}
