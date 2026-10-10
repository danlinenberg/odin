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
	LuMoon,
	LuSettings2,
	LuSparkles,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { openUrl } from "renderer/stores/in-app-browser";
import {
	MAX_NIGHT_PICKS,
	toggleNightPick,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { create } from "zustand";
import type { AllItem } from "../all/all-items";
import { allItems } from "../all/all-items";
import { cleanTitle, TaskDetails } from "../all/TaskDetails";
import { useStartAllItem } from "../all/use-start-item";
import { DropHint } from "../components/DropHint";
import { FEED_TABS } from "../components/feed-counts";
import { BUTTON, PILL } from "../components/pill";
import {
	DueChip,
	dayOf,
	effectiveDue,
	useReminders,
} from "../components/Reminders";
import { useReview } from "../hooks/useBacklogReview";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";
import type { SweptRow } from "../review/verdicts";
import { duplicateOf, type LedgerRow } from "./duplicates";
import { useNightAgentIntro } from "./NightAgentIntro";

/**
 * A feed title as something to read: Slack's *bold* and ~strike~ markers
 * dropped (they arrive raw), whitespace collapsed. The full original is the
 * card's tooltip.
 */
const ICON = Object.fromEntries(FEED_TABS.map(({ to, Icon }) => [to, Icon]));

const LEDGER_FEED: Record<LedgerRow["source"], string> = {
	reactions: "Slack",
	jira: "Jira",
	pr: "PR",
	notion: "Notion",
};

/**
 * The recommended queue: tasks from every feed that nobody has started yet -
 * no session on the board, idle or otherwise - in All tasks order, until you
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
 * One fresh run on the tasks as they are now - no cache on either side - then
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
	const swept = useReview((review) => review.swept);
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
		todos,
		reminders,
		prompt,
		rankInput,
		refetchSlack: () => void reactions.refetch(),
	};
}

/**
 * Next in line as the column shows it: waiting rows in the model's order (or
 * All tasks order), due ones pinned on top. Shared by the column and the
 * Night Agent runner, so the night works through exactly the list you see.
 */
export function useNextInLineQueue(showHidden = false) {
	const { rows, todos, reminders, prompt, rankInput, refetchSlack } =
		useNextInLineRows();
	const { ranking, applied } = useAiRanking();
	const pinOverdueDays = useNextInLinePrompt((s) => s.pinOverdueDays);
	const startItem = useStartAllItem(refetchSlack);
	const { livePaneFor } = startItem;
	// Every external item a session was ever started on - the work ledger
	// keeps the row after the session ends or is Done'd, which is exactly
	// what "already picked up, not next" needs. Display-only: the ranking's
	// input doesn't change, so this never costs a re-rank.
	const { data: ledger } = electronTrpc.workLog.list.useQuery(
		{ limit: 1000 },
		{ refetchInterval: 60_000 },
	);
	// Done anywhere means not next.
	const { isDone } = useDone();
	// My own tasks never reach the ledger; theirs is the session they launched.
	// Not the board's title match: an agent retitles its pane, and then the
	// Night Agent starts yesterday's todo all over again.
	const startedKeys = useMemo(
		() =>
			new Set([
				...(ledger ?? []).map((row) => row.externalId),
				...todos.flatMap((task) => (task.paneId ? [task.id] : [])),
			]),
		[ledger, todos],
	);
	// ponytail: every row rendered - a few hundred plain cards scroll fine.
	// Window it (render on scroll) if the feeds ever reach thousands.
	// The model's order, nothing else. Until it answers (or if it fails) the
	// column stays in feed order and says so - no rule of ours stands in.
	const waiting = rows.filter(
		(item) =>
			!livePaneFor(item) && !startedKeys.has(item.launch.key) && !isDone(item),
	);
	// The same ask arriving through a second feed. It stays in the column,
	// marked, for you to start or tick off - the Night Agent won't.
	const duplicateFor = (item: AllItem) => duplicateOf(item, ledger ?? []);
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
	// soonest first - a deadline outranks whatever the model thinks. Older
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

	return {
		...startItem,
		reminders,
		order,
		prompt,
		rankInput,
		waiting,
		isAiHidden,
		aiHiddenCount,
		duplicateFor,
		next,
		pinned,
		unpinned,
	};
}

export function NextInLine() {
	const { ranking, applied, startedAt, error } = useAiRanking();
	const picked = useNextInLinePrompt((s) => s.offHours.picked);
	const afterPicks = useNextInLinePrompt((s) => s.offHours.afterPicks);
	const nightAgentOn = useNextInLinePrompt((s) => s.offHours.enabled);
	const setOffHours = useNextInLinePrompt((s) => s.setOffHours);
	const navigate = useNavigate();
	const nightIntro = useNightAgentIntro();
	// The rows your instructions hide, per the model - revealed, dimmed, on ask.
	const [showHidden, setShowHidden] = useState(false);
	const {
		start,
		isLaunching,
		launchingKey,
		reminders,
		order,
		prompt,
		rankInput,
		waiting,
		isAiHidden,
		aiHiddenCount,
		duplicateFor,
		next,
		pinned,
		unpinned,
	} = useNextInLineQueue(showHidden);
	// Tonight's picks in pick order - the order the Night Agent starts them -
	// so the column reads top-down the way the night runs. From everything
	// waiting, not just what's shown: the AI's hides don't apply to your picks.
	const byKey = new Map(waiting.map((item) => [item.key, item]));
	const tonight = picked.flatMap((key) => byKey.get(key) ?? []);
	const notPicked = (item: AllItem) => !picked.includes(item.key);
	const pinnedRest = pinned.filter(notPicked);
	const rest = unpinned.filter(notPicked);
	// Open hands the link to the OS: a Slack permalink goes through Slack's
	// own hand-off into the desktop app, everything else to the browser.
	// Same Done as every feed, so a row done here is done there and back.
	const { markDone } = useDone();
	const doneWithUndo = (item: AllItem) =>
		markDone({ ...item, title: cleanTitle(item.title) });
	// The Review sweep's DROPs, so a row it wants gone says so here too. By key,
	// or by link for PRs, which Next in line keys by id and the sweep by repo#n.
	const swept = useReview((review) => review.swept);
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
	return (
		// Dressed like the board's columns, in Odin's own violet: it's the one
		// column the AI fills rather than a session status.
		<div className="relative flex min-w-[240px] flex-1 flex-col overflow-hidden rounded-xl border border-border bg-tertiary/85 bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--primary)_9%,transparent),transparent_160px)]">
			<span
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-primary via-primary/40 to-transparent"
			/>
			<div className="flex items-center gap-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-[.4px] text-soft-foreground">
				<span className="size-2 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
				Next in line
				<span className="ml-auto flex items-center gap-2">
					<button
						type="button"
						onClick={() => navigate({ to: "/settings/backlog" })}
						title={
							prompt
								? "Sorted your way - edit how in Settings"
								: "Tell the AI how to sort these, in Settings"
						}
						className={
							prompt
								? "text-primary hover:text-foreground"
								: "text-muted-foreground hover:text-foreground"
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
					<span className="rounded-[10px] bg-secondary px-2 font-medium">
						{tonight.length + pinnedRest.length + rest.length}
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
				{next.length + tonight.length === 0 ? (
					<div className="px-2 py-6 text-center text-xs text-muted-foreground">
						Nothing waiting to start
					</div>
				) : (
					<>
						{tonight.length > 0 && (
							<div className="flex items-center gap-1.5 px-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[.4px] text-primary">
								<LuMoon className="size-3" aria-hidden />
								Tonight · {tonight.length}
								<button
									type="button"
									onClick={() =>
										setOffHours({
											afterPicks: afterPicks === "stop" ? "ranked" : "stop",
										})
									}
									title="What the Night Agent does after these. Click to switch."
									className="ml-auto font-normal normal-case tracking-normal text-muted-foreground hover:text-foreground"
								>
									then {afterPicks === "stop" ? "stop" : "the rest below"}
								</button>
							</div>
						)}
						{tonight.length > 0 && !nightAgentOn && (
							<button
								type="button"
								onClick={() =>
									nightIntro.gate(() => setOffHours({ enabled: true }))
								}
								title="Picks only start while the Night Agent is on"
								className="mx-1 rounded-md border border-attention/40 bg-attention/10 px-2 py-1 text-left text-[11px] text-attention hover:bg-attention/20"
							>
								Night Agent is off, these won't start. Turn on
							</button>
						)}
						{tonight.map((item) => card(item, false))}
						{pinnedRest.length > 0 && (
							<div
								className={cn(
									"px-1 text-[10.5px] font-semibold uppercase tracking-[.4px] text-attention",
									tonight.length
										? "mt-1 border-t border-border pt-2"
										: "pt-0.5",
								)}
							>
								Due · {pinnedRest.length}
							</div>
						)}
						{pinnedRest.map((item) => card(item, true))}
						{(tonight.length > 0 || pinnedRest.length > 0) &&
							rest.length > 0 && (
								<div className="mt-1 border-t border-border px-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
									Everything else
								</div>
							)}
						{rest.map((item) => card(item, false))}
					</>
				)}
			</div>
			{nightIntro.dialog}
		</div>
	);

	function card(item: AllItem, due: boolean) {
		const Icon = ICON[item.to];
		const meta = [item.person, item.context].filter(Boolean).join(" · ");
		const duplicate = duplicateFor(item);
		const pickIndex = picked.indexOf(item.key);
		const pickFull = pickIndex < 0 && picked.length >= MAX_NIGHT_PICKS;
		return (
			<div
				key={item.key}
				className={cn(
					"group relative flex items-start gap-2 rounded-[10px] border border-border bg-card px-2.5 py-2 transition-colors hover:border-input hover:bg-secondary",
					(isAiHidden(item) || duplicate) && "opacity-50",
				)}
				title={
					duplicate
						? "Suspected duplicate - the Night Agent skips it. Start it yourself if it isn't."
						: isAiHidden(item)
							? "Hidden by your Next in line instructions"
							: undefined
				}
			>
				{/* A to-do's checkbox, where a to-do's checkbox goes. */}
				<button
					type="button"
					onClick={() => doneWithUndo(item)}
					title="Mark done - take it off Next in line"
					aria-label="Mark done"
					className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input text-transparent transition-colors hover:border-success hover:bg-success/15 hover:text-success"
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
								className="line-clamp-2 break-words text-left text-[12.5px] font-medium leading-[1.4] text-foreground"
							>
								{emojify(cleanTitle(item.title))}
							</span>
							<div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
								{Icon && <Icon className="size-3 shrink-0" aria-hidden />}
								{item.priority && (
									<span
										className={cn(
											"shrink-0 font-medium",
											item.urgency === "high"
												? "text-danger"
												: item.urgency === "medium"
													? "text-attention"
													: "text-muted-foreground",
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
								<DropHint evidence={dropFor(item)?.evidence ?? ""} />
							)}
							{duplicate && (
								<div
									className={`mt-1 line-clamp-2 w-full rounded-[5px] px-[7px] py-px text-[11px] font-medium ${PILL.attention}`}
								>
									Suspected duplicate of: {cleanTitle(duplicate.title)} ·{" "}
									{LEDGER_FEED[duplicate.source]} · started{" "}
									{new Date(duplicate.startedAt).toLocaleDateString(undefined, {
										month: "short",
										day: "numeric",
									})}
								</div>
							)}
						</div>
					</HoverCardTrigger>
					<HoverCardContent
						side="left"
						align="start"
						className="w-[440px] border-border bg-popover p-3"
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
						"absolute right-1.5 top-1.5 hidden items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 shadow-lg group-focus-within:flex group-hover:flex",
						launchingKey === item.launch.key && "flex",
					)}
				>
					<button
						type="button"
						onClick={() =>
							pickIndex >= 0
								? toggleNightPick(item.key)
								: nightIntro.gate(() => toggleNightPick(item.key))
						}
						disabled={pickFull}
						aria-pressed={pickIndex >= 0}
						aria-label="Pick for tonight"
						title={
							pickIndex >= 0
								? "Take off tonight's picks"
								: pickFull
									? `Tonight's picks are full (${MAX_NIGHT_PICKS})`
									: "Pick for tonight - the Night Agent starts picks first"
						}
						className={cn(
							"rounded-md p-1 hover:bg-accent disabled:opacity-40",
							pickIndex >= 0
								? "text-primary"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<LuMoon className="size-3.5" aria-hidden />
					</button>
					{item.url && /^https?:\/\//.test(item.url) && (
						<button
							type="button"
							onClick={() => item.url && openUrl(item.url)}
							title={
								item.source === "Slack"
									? "Open the thread in Slack"
									: "Open in your browser"
							}
							aria-label="Open"
							className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							<LuExternalLink className="size-3.5" aria-hidden />
						</button>
					)}
					<button
						type="button"
						disabled={isLaunching}
						onClick={() => void start(item)}
						title="Start an agent session on this task"
						className={`rounded-md px-2 py-0.5 text-[11px] font-semibold disabled:opacity-60 ${BUTTON.primary}`}
					>
						{launchingKey === item.launch.key ? "starting…" : "▶ Start"}
					</button>
				</div>
			</div>
		);
	}
}

/**
 * What a card's hover says: the task in full (TaskDetails), plus what only
 * Next in line knows - the due date you set, where the AI ranked it, and what
 * the Review sweep found.
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
	const extraRows: [string, string][] = [];
	if (due) extraRows.push(["Due", due]);
	if (rank !== undefined) extraRows.push(["AI rank", `#${rank + 1}`]);
	return (
		<TaskDetails item={item} extraRows={extraRows}>
			{swept && (
				<div
					className={cn(
						"rounded-md px-2 py-1.5 text-[11.5px]",
						swept.verdict === "DROP"
							? "bg-danger/15 text-danger"
							: "bg-secondary text-soft-foreground",
					)}
				>
					<span className="font-semibold">Review sweep: {swept.verdict}</span>
					{swept.evidence && ` - ${swept.evidence}`}
				</div>
			)}
		</TaskDetails>
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
			<div className="mx-2 mb-2 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/8 px-2.5 py-2 text-[11.5px] text-primary">
				<LuLoaderCircle
					className="mt-px size-3.5 shrink-0 animate-spin text-primary"
					aria-hidden
				/>
				<span>
					AI is ranking {count} tasks…{" "}
					{Math.max(0, Math.round((now - startedAt) / 1000))}s
					<span className="block text-muted-foreground">
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
			className="ml-auto flex shrink-0 items-center gap-1 rounded-md bg-primary/15 px-2 py-0.5 font-medium text-primary hover:bg-primary/25"
		>
			<LuSparkles className="size-3 text-primary" aria-hidden />
			{applied && ranked ? "Re-sort" : "Sort with AI"}
		</button>
	);
	return (
		<div className="mx-2 mb-2 px-1 text-[11px] text-muted-foreground">
			<div className="flex items-center gap-1.5">
				{applied && ranked ? (
					<>
						<LuSparkles className="size-3 text-primary" aria-hidden />
						Sorted by AI
						<button
							type="button"
							onClick={onUndo}
							className="hover:text-foreground"
						>
							· undo
						</button>
					</>
				) : (
					"Newest first"
				)}
				{button}
			</div>
			{error && (
				<div
					className="mt-1 cursor-text select-text truncate text-danger"
					title={error}
				>
					AI ranking failed: {error}
				</div>
			)}
		</div>
	);
}

/** "show hidden (N)" - the rows your instructions hide, never without a way back. */
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
				"text-[12px] text-muted-foreground transition-colors hover:text-foreground",
				className,
			)}
		>
			{showing ? "hide" : "show"} hidden ({count})
		</button>
	);
}
