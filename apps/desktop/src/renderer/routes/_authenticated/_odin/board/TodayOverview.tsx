import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	LuCircleCheck,
	LuHourglass,
	LuLoaderCircle,
	LuMessageCircleQuestion,
	LuPause,
	LuPlane,
	LuPlay,
	LuPlus,
	LuRefreshCw,
} from "react-icons/lu";
import { useHotkey, useHotkeyDisplay } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { openUrl } from "renderer/stores/in-app-browser";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useTodayOverview } from "renderer/stores/today-overview";
import { type AllItem, livePanesOn, urgencyOf } from "../all/all-items";
import { TaskDetails } from "../all/TaskDetails";
import { TaskSidePanel } from "../all/TaskSidePanel";
import { dayAfter, useTaskMeta } from "../all/task-meta";
import { useAllItems } from "../all/use-all-items";
import { useStartAllItem } from "../all/use-start-item";
import { ROW_LIVE_BUTTON } from "../components/FeedChrome";
import { BUTTON } from "../components/pill";
import { daysUntil, effectiveDue, useReminders } from "../components/Reminders";
import {
	isAnswerItem,
	isApprovalItem,
	isDoneItem,
	isYouOnly,
	itemOptions,
} from "./action-items";
import { actionItems } from "./brief";
import { phoneReply } from "./phone-resume";
import {
	dueLabel,
	itemKind,
	pilotPick,
	rankToday,
	type TodayEntry,
	type TodayGroup,
	type TodaySignals,
	type TodayTaskView,
	todayCounts,
	todayGroup,
	todayGroupLabel,
	todayLanes,
	todayTasks,
	todayTitle,
} from "./today";
import { moveSelection, type SideRow, todaySide } from "./today-side";

/** A board session, as the board hands it to the overview. */
export interface TodayCard {
	/** The board pane - a click opens it. */
	paneId: string;
	title: string;
	sessionId: string | null;
	/** The brief's status line, shown until the plain words are written. */
	status: string | null;
	starred: boolean;
	signals: TodaySignals;
	/** Its facts in plain words: where it runs, repo, last message, pull requests. */
	facts?: ReactNode;
}

/** One open session as the overview reads it. */
export interface TodayItem extends TodayEntry {
	key: string;
	title: string;
	sessionId: string | null;
	status: string | null;
	waitingOn: string | null;
	/** The linked task's priority as its source names it. */
	priority: string | null;
	/** The task it was started from, when Tasks knows it. */
	from: { source: string; title: string; url: string | null } | null;
	/** That task's row in Tasks, for the summary panel. */
	row?: AllItem | null;
	facts?: ReactNode;
}

/**
 * The board's sessions with what Tasks knows about each one's task: its due
 * date, priority, and who it waits on when it was parked in Waiting on others.
 */
function useTodayItems(cards: TodayCard[]): TodayItem[] {
	const rows = useAllItems();
	const panes = useTabsStore((s) => s.panes);
	const waiting = useTaskMeta((s) => s.waiting);
	const reminders = useReminders((s) => s.reminders);
	return useMemo(() => {
		const all = Object.values(panes);
		const taskOf = new Map<string, (typeof rows)[number]>();
		for (const row of rows)
			for (const pane of livePanesOn(all, row))
				if (!taskOf.has(pane.id)) taskOf.set(pane.id, row);
		return cards.map((card) => {
			const task = taskOf.get(card.paneId);
			const parked = task ? waiting[task.key] : undefined;
			const waitingOn =
				card.signals.waitingOn ?? (parked ? parked.on || "someone else" : null);
			return {
				key: card.paneId,
				title: card.title,
				sessionId: card.sessionId,
				status: card.status,
				starred: card.starred,
				waitingOn,
				group: todayGroup({ ...card.signals, waitingOn }),
				due: task ? effectiveDue(task.key, reminders, task.dueDate) : null,
				priority: task?.priority ?? null,
				urgency: task?.urgency ?? urgencyOf(task?.priority),
				from: task
					? { source: task.source, title: task.title, url: task.url }
					: null,
				row: task ?? null,
				facts: card.facts,
			};
		});
	}, [cards, rows, panes, waiting, reminders]);
}

const GROUP_MARK: Record<
	TodayGroup,
	{ Icon: ComponentType<{ className?: string }>; tone: string }
> = {
	"needs-you": { Icon: LuMessageCircleQuestion, tone: "text-attention-ink" },
	"almost-done": { Icon: LuCircleCheck, tone: "text-success-ink" },
	running: { Icon: LuPlay, tone: "text-working-ink" },
	waiting: { Icon: LuHourglass, tone: "text-primary-ink" },
	paused: { Icon: LuPause, tone: "text-muted-foreground" },
};

/** Moving without you folds past this many tasks. */
const MOVING_FOLD = 3;

const LINK =
	"font-medium text-primary-ink underline-offset-2 hover:underline disabled:opacity-50";

/** Overdue and due within a day stand out; later dates read as plain text. */
const dueTone = (left: number) =>
	left < 0 ? "text-danger-ink" : left <= 1 ? "text-attention-ink" : "";

/**
 * Today: your open work as one page of plain text. A sentence over all of
 * it, then two lanes of the board's sessions, grouped by Claude into the
 * work they serve. Waiting on you: numbered, each titled by what you do
 * next, with an Explanation of the task and Where it stands. Moving without
 * you: what Claude or someone else has, or is on hold. Then your tasks no
 * session works on yet. On a wide window the page fills it: Waiting on you
 * on the left, the rest on the right. No board columns: Board view has those.
 */
export function TodayOverview({
	cards,
	openPaneId,
	pilot,
	beside,
	onNew,
	onOpen,
	onDone,
	onSnooze,
}: {
	cards: TodayCard[];
	/** The session open beside the page: its task is marked. */
	openPaneId?: string;
	/** Auto pilot: one task at a time instead of the whole page. */
	pilot?: boolean;
	/** Auto pilot: width the session drawer takes on the right, while open. */
	beside?: string;
	/** Auto pilot: opens the New session composer. */
	onNew?: () => void;
} & TodayActions) {
	const now = Date.now();
	const today = dayAfter(now, 0);
	// In the order to do them, so the summary Claude writes starts where the
	// page does.
	const board = useTodayItems(cards);
	const items = useMemo(() => rankToday(board, today), [board, today]);
	const [refresh, setRefresh] = useState(0);
	const { data, isFetching, error } =
		electronTrpc.terminal.todayOverviewLines.useQuery(
			{
				items: items.map((item) => ({
					key: item.key,
					sessionId: item.sessionId,
					title: item.title,
					group: todayGroupLabel(item.group),
					due: item.due ?? null,
					priority: item.priority,
					waitingOn: item.waitingOn,
					from: item.from ? `${item.from.source}: ${item.from.title}` : null,
				})),
				refresh: refresh || undefined,
			},
			{
				enabled: items.length > 0,
				staleTime: 30 * 60_000,
				retry: false,
				refetchOnWindowFocus: false,
				placeholderData: (previous) => previous,
			},
		);
	// Each session's goal from its brief: what a task is about at once, and
	// wherever the written overview is missing or failed.
	const sessionIds = items.flatMap((item) =>
		item.sessionId ? [item.sessionId] : [],
	);
	const { data: goals } = electronTrpc.terminal.todaySessionGoals.useQuery(
		{ sessionIds },
		{
			enabled: sessionIds.length > 0,
			staleTime: 5 * 60_000,
			retry: false,
			refetchOnWindowFocus: false,
			placeholderData: (previous) => previous,
		},
	);
	const lanes = useMemo(
		() =>
			todayLanes(
				todayTasks(
					data?.tasks ?? [],
					items.map((item) => ({
						...item,
						goal: item.sessionId ? (goals?.[item.sessionId] ?? null) : null,
					})),
					today,
				),
			),
		[data, items, goals, today],
	);
	// Arrow keys walk the page top to bottom: your lane, then the other.
	const tasks = useMemo(() => [...lanes.yours, ...lanes.moving], [lanes]);
	const side = useTodaySide();
	const enabled = useTodayOverview((s) => s.enabled);
	const setEnabled = useTodayOverview((s) => s.setEnabled);
	const [allMoving, setAllMoving] = useState(false);
	const dateLine = new Date(now).toLocaleDateString(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
	});

	// Today: Next / Previous Task move between tasks, Open Task opens the
	// picked one's first session (down, up and Enter unless rebound).
	const [selected, setSelected] = useState(-1);
	// The task whose summary is open beside the page, like Tasks' side panel.
	const [shown, setShown] = useState<string | null>(null);
	const shownTask = tasks.find((task) => task.id === shown) ?? null;
	// The task its session was started from opens in Tasks' own side panel,
	// with a link to the session; a session started from nothing keeps
	// Today's summary.
	const shownRow = shownTask?.items.find((item) => item.row)?.row ?? null;
	// A session opens in the board's drawer: the summary makes room for it,
	// and comes back when the drawer closes.
	const [backTo, setBackTo] = useState<string | null>(null);
	const openSession = (paneId: string) => {
		if (shown) setBackTo(shown);
		setShown(null);
		onOpen(paneId);
	};
	useEffect(() => {
		if (openPaneId || !backTo) return;
		setShown(backTo);
		setBackTo(null);
	}, [openPaneId, backTo]);
	// After you answered, finished or snoozed a task: the next one waiting on
	// you comes up in the panel (the list itself catches up on its own).
	const nextAfter = (id: string) => {
		const at = lanes.yours.findIndex((task) => task.id === id);
		return lanes.yours[at + 1] ?? lanes.yours.find((task) => task.id !== id);
	};
	const advance = (id: string) => setShown(nextAfter(id)?.id ?? null);
	const actions: TodayActions = { onOpen: openSession, onDone, onSnooze };
	const step = (by: 1 | -1) => {
		const next = moveSelection(by, selected, tasks.length);
		if (next === null) return;
		setSelected(next);
		document
			.querySelector(`[data-today-task="${tasks[next].id}"]`)
			?.scrollIntoView({ block: "nearest" });
	};
	const keys = { enableOnFormTags: false, enableOnContentEditable: false };
	useHotkey("TODAY_NEXT", () => step(1), keys);
	useHotkey("TODAY_PREV", () => step(-1), keys);
	useHotkey(
		"TODAY_OPEN",
		() => {
			const task = tasks[selected];
			if (task) setShown(task.id);
		},
		{ ...keys, enabled: selected >= 0 },
	);

	if (pilot)
		return (
			<AutoPilot
				yours={lanes.yours}
				moving={lanes.moving}
				now={now}
				openPaneId={openPaneId}
				beside={beside}
				actions={actions}
				onNew={onNew}
			/>
		);

	return (
		<section
			aria-label="Today"
			data-testid="today-overview"
			className="flex min-h-0 flex-1"
		>
			<div className="@container min-w-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-[1600px] flex-col gap-7 px-6 pb-10 pt-5 @5xl:px-10">
					<header className="flex flex-col gap-2">
						<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
							<h1 className="text-[22px] font-semibold tracking-[-.3px]">
								Today
							</h1>
							<span className="text-[13px] text-muted-foreground">
								{dateLine}
							</span>
							<button
								type="button"
								title="Write it again from the sessions' newest briefs"
								disabled={!items.length || isFetching}
								onClick={() => setRefresh(Date.now())}
								className={cn(
									"ml-auto inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[12px] font-semibold disabled:opacity-50",
									BUTTON.secondary,
								)}
							>
								<LuRefreshCw
									className={cn("size-3", isFetching && "animate-spin")}
									aria-hidden
								/>
								Refresh
							</button>
						</div>
						<p className="max-w-[95ch] select-text cursor-text text-[16px] leading-relaxed">
							{data?.summary ?? `${todayCounts(items)}.`}
						</p>
						{isFetching && !data && items.length > 0 && (
							<p className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
								<LuLoaderCircle className="size-3 animate-spin" />
								Writing it in plain words...
							</p>
						)}
						{error && !isFetching && (
							<p className="select-text cursor-text text-[12px] text-danger-ink">
								Couldn't write the overview: {error.message}{" "}
								<button
									type="button"
									onClick={() => setRefresh(Date.now())}
									className={LINK}
								>
									Try again
								</button>
							</p>
						)}
					</header>

					{tasks.length === 0 && (
						<p className="text-[14px] text-muted-foreground">
							No open sessions. Start one from Tasks, or from the board.
						</p>
					)}

					{tasks.length > 0 && (
						<div className="grid items-start gap-x-12 gap-y-8 @5xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
							<section aria-label="Waiting on you">
								<h2 className="mb-3 flex items-baseline gap-2">
									<span className="text-[17px] font-semibold text-attention-ink">
										Waiting on you
									</span>
									<span className="text-[13px] text-muted-foreground">
										in the order to do them
									</span>
								</h2>
								{lanes.yours.length === 0 ? (
									<p className="text-[14px] text-muted-foreground">
										Nothing waits on you right now.
									</p>
								) : (
									<ol className="flex flex-col gap-2">
										{lanes.yours.map((task, i) => {
											const open =
												shown === task.id ||
												task.items.some((item) => item.key === openPaneId);
											const picked = tasks[selected]?.id === task.id;
											return i === 0 ? (
												<StartHere
													key={task.id}
													task={task}
													now={now}
													picked={picked}
													open={open}
													actions={actions}
													onShow={setShown}
													onActed={() => {
														if (shown === task.id) advance(task.id);
													}}
												/>
											) : (
												<YourRow
													key={task.id}
													task={task}
													number={i + 1}
													now={now}
													picked={picked}
													open={open}
													onShow={setShown}
												/>
											);
										})}
									</ol>
								)}
							</section>

							<div className="flex min-w-0 flex-col gap-7">
								{lanes.moving.length > 0 && (
									<section aria-label="Moving without you">
										<h2 className="mb-3 flex items-baseline gap-2">
											<span className="text-[17px] font-semibold text-working-ink">
												Moving without you
											</span>
											<span className="text-[13px] text-muted-foreground">
												nothing to do, just so you know
											</span>
										</h2>
										<ul className="flex flex-col">
											{(allMoving || lanes.moving.length <= MOVING_FOLD
												? lanes.moving
												: lanes.moving.slice(0, MOVING_FOLD)
											).map((task) => (
												<MovingRow
													key={task.id}
													task={task}
													now={now}
													picked={tasks[selected]?.id === task.id}
													open={
														shown === task.id ||
														task.items.some((item) => item.key === openPaneId)
													}
													onShow={setShown}
												/>
											))}
										</ul>
										{lanes.moving.length > MOVING_FOLD && (
											<button
												type="button"
												onClick={() => setAllMoving((all) => !all)}
												className={cn(LINK, "mt-1 px-3 text-[12px]")}
											>
												{allMoving
													? "Show fewer"
													: `Show all ${lanes.moving.length}`}
											</button>
										)}
									</section>
								)}
								<ComingUp side={side} onOpen={openSession} />
							</div>
						</div>
					)}
					{tasks.length === 0 && <ComingUp side={side} onOpen={openSession} />}

					<label className="flex items-center gap-2 border-t border-border pt-3 text-[12px] text-muted-foreground">
						<input
							type="checkbox"
							checked={enabled}
							onChange={(event) => setEnabled(event.target.checked)}
						/>
						Show this every morning when Odin opens (the Today icon opens it any
						time)
					</label>
				</div>
			</div>
			{shownTask && shownRow && (
				<TaskSidePanel
					key={shownRow.key}
					item={shownRow}
					onGoTo={openSession}
					onClose={() => setShown(null)}
					top={
						<div className="mb-3">
							<TaskItems
								task={shownTask}
								onOpen={openSession}
								onSent={() => advance(shownTask.id)}
							/>
						</div>
					}
				/>
			)}
			{shownTask && !shownRow && (
				<TodayTaskPanel
					task={shownTask}
					now={now}
					actions={actions}
					onActed={() => advance(shownTask.id)}
					onNext={
						lanes.yours.length > 1 ? () => advance(shownTask.id) : undefined
					}
					onClose={() => setShown(null)}
				/>
			)}
		</section>
	);
}

/** "the fix is written" -> "The fix is written." */
const sentence = (text: string | null) => {
	const said = text?.trim();
	if (!said) return null;
	const cap = said[0].toUpperCase() + said.slice(1);
	return /[.!?]$/.test(cap) ? cap : `${cap}.`;
};

/** Where it stands and what is left, as one line. */
const standing = (task: TodayTaskView<TodayItem>) =>
	[task.line, task.left].map(sentence).filter(Boolean).join(" ") || null;

/** Its due date, a high priority and its star, as chips in front of the title. */
function TaskMarks({
	task,
	now,
}: {
	task: TodayTaskView<TodayItem>;
	now: number;
}) {
	const due = task.items
		.map((item) => item.due)
		.filter((day): day is string => !!day)
		.sort()[0];
	const left = due ? daysUntil(due, now) : null;
	const high = task.items.find((item) => item.urgency === "high");
	const starred = task.items.some((item) => item.starred);
	if (!due && !high && !starred) return null;
	return (
		<span className="inline-flex flex-wrap items-baseline gap-1.5 text-[12px] font-semibold">
			{due && left !== null && (
				<span className={cn(CHIP, dueTone(left))}>{dueLabel(due, left)}</span>
			)}
			{high && (
				<span className={cn(CHIP, "text-danger-ink")}>
					{high.priority ?? "High"} priority
				</span>
			)}
			{starred && <span className={cn(CHIP, "text-attention-ink")}>★</span>}
		</span>
	);
}

const CHIP = "rounded-md border border-border px-1.5 py-px";

/** A session's latest ACTION ITEMS, read from its transcript; [] when it left none. */
function useActionItems(sessionId: string | null | undefined): string[] {
	const { data: transcript } =
		electronTrpc.terminal.readClaudeTranscript.useQuery(
			{ sessionId: sessionId ?? "" },
			{ enabled: !!sessionId, retry: false, staleTime: 60_000 },
		);
	return useMemo(
		() => (transcript ? actionItems(transcript.messages) : []),
		[transcript],
	);
}

type TaskProps = {
	task: TodayTaskView<TodayItem>;
	now: number;
	/** Picked with the arrow keys. */
	picked: boolean;
	/** Its summary, or one of its sessions, is open beside the page. */
	open: boolean;
	/** Opens its summary beside the page. */
	onShow: (taskId: string) => void;
};

/** A small label over a block of a task's text. */
const LABEL =
	"mb-0.5 text-[11px] font-semibold uppercase tracking-[.06em] text-muted-foreground";

/** What Today can do to a task's session without leaving the page. */
export interface TodayActions {
	/** Opens the session in the drawer beside the page. */
	onOpen: (paneId: string) => void;
	/** Ends the session and takes it off the board, like the board's Done. */
	onDone?: (paneId: string) => void;
	/** Done for now; it comes back on `day` (YYYY-MM-DD), like Remind me. */
	onSnooze?: (paneId: string, day: string) => void;
}

/**
 * The first task to do, set apart: "Start here", what you do, what the task
 * is and why it matters, where it stands, its action items to answer right
 * here, its sessions, and Open, Done and Snooze.
 */
function StartHere({
	task,
	now,
	open,
	picked,
	actions,
	onShow,
	onActed,
	onSkip,
}: Omit<TaskProps, "onShow"> & {
	actions: TodayActions;
	onShow: (taskId: string) => void;
	/** After you answered, finished or snoozed it: the next task comes up. */
	onActed: () => void;
	/** Auto pilot only: moves this task to the end of the queue. */
	onSkip?: () => void;
}) {
	const first = task.items[0];
	const todo = useActionItems(first.sessionId);
	const stands = standing(task);
	return (
		<li
			data-today-task={task.id}
			className={cn(
				"@container flex flex-col gap-3 rounded-xl border-2 border-attention/45 bg-attention/[0.05] px-5 py-4",
				open && "border-primary/60 bg-primary/10",
				picked && "ring-2 ring-primary/60",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="rounded-full bg-attention px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[.08em] text-background">
					Start here
				</span>
				{todo[0] && (
					<span className={cn(CHIP, "text-[12px] font-semibold")}>
						{itemKind(todo[0])}
					</span>
				)}
				<TaskMarks task={task} now={now} />
			</div>
			<button
				type="button"
				title="Show its summary beside the page"
				onClick={() => onShow(task.id)}
				className="text-left text-[19px] font-semibold leading-snug underline-offset-2 hover:underline"
			>
				{todayTitle(task, todo[0])}
			</button>
			<p className="select-text cursor-text text-[14px] leading-snug">
				<span className="font-semibold">{task.name}</span>
				{task.about && <>: {sentence(task.about)}</>}
			</p>
			<div className="grid select-text cursor-text gap-x-6 gap-y-2.5 text-[14px] leading-relaxed @2xl:grid-cols-2">
				{task.explain && (
					<div>
						<p className={LABEL}>Why it matters</p>
						<p className="text-foreground/90">{sentence(task.explain)}</p>
					</div>
				)}
				{stands && (
					<div>
						<p className={LABEL}>Where it stands</p>
						<p className="text-foreground/90">{stands}</p>
					</div>
				)}
			</div>
			<TaskItems
				task={task}
				onOpen={actions.onOpen}
				onShow={() => onShow(task.id)}
				onSent={onActed}
			/>
			<TaskButtons
				task={task}
				actions={actions}
				onActed={onActed}
				onSkip={onSkip}
			/>
		</li>
	);
}

/**
 * Each of the task's sessions with its action items, answerable here; the
 * session's title above them when the task has several.
 */
function TaskItems({
	task,
	onOpen,
	onShow,
	onSent,
}: {
	task: TodayTaskView<TodayItem>;
	onOpen: (paneId: string) => void;
	/** On the page: a session's title opens the task's summary, not the session. */
	onShow?: () => void;
	onSent?: () => void;
}) {
	return (
		<div className="flex flex-col gap-3">
			{task.items.map((item) => (
				<SessionItems
					key={item.key}
					item={item}
					titled={task.items.length > 1}
					onOpen={onShow ? () => onShow() : onOpen}
					preview={!!onShow}
					onSent={onSent}
				/>
			))}
		</div>
	);
}

/** One session's line (title, facts) and its action items with their buttons. */
function SessionItems({
	item,
	titled,
	onOpen,
	preview,
	onSent,
}: {
	item: TodayItem;
	titled: boolean;
	onOpen: (paneId: string) => void;
	/** The title opens the task's summary beside the page. */
	preview?: boolean;
	onSent?: () => void;
}) {
	const todo = useActionItems(item.sessionId);
	return (
		<div className="flex flex-col gap-1.5">
			<p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] text-muted-foreground">
				<button
					type="button"
					title={
						preview
							? "Show its summary beside the page"
							: `${todayGroupLabel(item.group)} - open it beside this page`
					}
					onClick={() => onOpen(item.key)}
					className={cn(LINK, "text-[13px]")}
				>
					{item.title}
				</button>
				{titled && (
					<span className={GROUP_MARK[item.group].tone}>
						{todayGroupLabel(item.group).toLowerCase()}
					</span>
				)}
				{item.facts && (
					<span className="inline-flex flex-wrap items-baseline gap-x-1.5">
						<span>-</span>
						{item.facts}
					</span>
				)}
			</p>
			{todo.length > 0 && (
				<ol className="flex flex-col gap-1.5">
					{todo.map((text, i) => (
						<AnswerItem
							key={text}
							paneId={item.key}
							item={text}
							number={i + 1}
							onSent={onSent}
						/>
					))}
				</ol>
			)}
		</div>
	);
}

/**
 * Sends a line to a session from Today: an ended one resumes with it, a
 * running remote one gets it once Claude is back, a running one has it typed in.
 */
function useSendToSession() {
	const write = electronTrpc.terminal.write.useMutation();
	return async (paneId: string, text: string) => {
		if (phoneReply(paneId, text) === "live") {
			const { typeIntoClaude } = await import("./ChatView");
			await typeIntoClaude(write.mutateAsync, paneId, text);
		}
	};
}

/**
 * One action item with what answers it, as in the session's Action items
 * card: Approve, Done for a "tell me when", a button per choice and a reply
 * box for a question, Do it for the rest; nothing for "(you only)".
 */
function AnswerItem({
	paneId,
	item,
	number,
	onSent,
}: {
	paneId: string;
	item: string;
	number: number;
	onSent?: () => void;
}) {
	const send = useSendToSession();
	const [sent, setSent] = useState(false);
	const [answer, setAnswer] = useState("");
	const { text, options } = itemOptions(item);
	const asks = isAnswerItem(item) || options.length > 0;
	const reply = (message: string) => {
		setSent(true);
		send(paneId, message)
			.then(() => {
				toast.success("Sent to the session");
				onSent?.();
			})
			.catch((error) => {
				setSent(false);
				toast.error("Couldn't send it", {
					description: error instanceof Error ? error.message : String(error),
				});
			});
	};
	const answerWith = (said: string) =>
		reply(`Action item ${number} (${item}): ${said}`);
	return (
		<li className="flex flex-col gap-1.5 rounded-lg border border-attention/35 bg-attention/[0.07] px-3 py-2">
			<p className="flex items-baseline gap-2 select-text cursor-text text-[14px] leading-snug">
				<span className="font-semibold text-attention-ink">{number}.</span>
				<span className="min-w-0 break-words">{text}</span>
			</p>
			{sent ? (
				<p className="pl-5 text-[12px] text-muted-foreground">Sent.</p>
			) : (
				<div className="flex flex-wrap items-center gap-1.5 pl-5">
					{isApprovalItem(item) ? (
						<button
							type="button"
							className={ITEM_BUTTON}
							onClick={() =>
								reply(`Approved - go ahead with action item ${number}: ${item}`)
							}
						>
							Approve
						</button>
					) : isDoneItem(item) ? (
						<button
							type="button"
							className={ITEM_BUTTON}
							onClick={() => answerWith("Done")}
						>
							Done
						</button>
					) : asks ? (
						<>
							{options.map((option) => (
								<button
									key={option}
									type="button"
									className={ITEM_BUTTON}
									onClick={() => answerWith(option)}
								>
									{option}
								</button>
							))}
							<form
								className="flex min-w-[200px] flex-1 items-center gap-1.5"
								onSubmit={(event) => {
									event.preventDefault();
									if (answer.trim()) answerWith(answer.trim());
								}}
							>
								<input
									value={answer}
									onChange={(event) => setAnswer(event.target.value)}
									placeholder="Your answer"
									className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-0.5 text-[13px]"
								/>
								<button
									type="submit"
									disabled={!answer.trim()}
									className={ITEM_BUTTON}
								>
									Send
								</button>
							</form>
						</>
					) : isYouOnly(item) ? null : (
						<button
							type="button"
							className={ITEM_BUTTON}
							onClick={() => reply(`Do action item ${number} for me: ${item}`)}
						>
							Do it
						</button>
					)}
				</div>
			)}
		</li>
	);
}

const ITEM_BUTTON =
	"shrink-0 rounded-md border border-attention/40 px-2 py-0.5 text-[12px] font-medium text-attention-ink hover:bg-attention/15 disabled:opacity-50";

/** Go to session, Done, Snooze until tomorrow and Skip, for the task's first session. */
function TaskButtons({
	task,
	actions,
	onActed,
	onNext,
	onSkip,
}: {
	task: TodayTaskView<TodayItem>;
	actions: TodayActions;
	onActed: () => void;
	/** Auto pilot only: moves the task to the end of the queue. */
	onSkip?: () => void;
	/** Shown in the summary panel: moves to the next task waiting on you. */
	onNext?: () => void;
}) {
	const paneId = task.items[0].key;
	const ghost =
		"rounded-[7px] px-2.5 py-1 text-[12px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground";
	return (
		<div className="flex flex-wrap items-center gap-2">
			<button
				type="button"
				onClick={() => actions.onOpen(paneId)}
				className={ROW_LIVE_BUTTON}
			>
				Go to session →
			</button>
			{actions.onDone && (
				<button
					type="button"
					title="End the session and take it off the board"
					onClick={() => {
						actions.onDone?.(paneId);
						onActed();
					}}
					className={ghost}
				>
					✓ Done
				</button>
			)}
			{actions.onSnooze && (
				<button
					type="button"
					title="Put it away; it comes back tomorrow"
					onClick={() => {
						actions.onSnooze?.(paneId, dayAfter(Date.now(), 1));
						onActed();
					}}
					className={ghost}
				>
					Snooze till tomorrow
				</button>
			)}
			{onSkip && (
				<button
					type="button"
					title="Move it to the end of the queue"
					onClick={onSkip}
					className={ghost}
				>
					Skip for now
				</button>
			)}
			{onNext && (
				<button type="button" onClick={onNext} className={cn(ghost, "ml-auto")}>
					Next →
				</button>
			)}
		</div>
	);
}

/**
 * A task waiting on you after the first: one line with its number, what you
 * do, what kind of item it is, how many items, and its due date and priority.
 * The rest is in its summary beside the page.
 */
function YourRow({
	task,
	number,
	now,
	picked,
	open,
	onShow,
}: TaskProps & { number: number }) {
	const todo = useActionItems(task.items[0].sessionId);
	return (
		<li data-today-task={task.id}>
			<button
				type="button"
				title="Show its summary beside the page"
				onClick={() => onShow(task.id)}
				className={cn(
					"flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-left hover:bg-secondary/60",
					open && "bg-primary/10",
					picked && "ring-2 ring-primary/60",
				)}
			>
				<span className="w-5 shrink-0 text-[14px] font-semibold text-attention">
					{number}
				</span>
				<span className="min-w-0 flex-1 text-[15px] font-medium leading-snug">
					{todayTitle(task, todo[0])}
					<span className="ml-2 text-[13px] font-normal text-muted-foreground">
						{task.name}
					</span>
				</span>
				{todo[0] && (
					<span className={cn(CHIP, "text-[11px] font-semibold")}>
						{itemKind(todo[0])}
						{todo.length > 1 && ` +${todo.length - 1}`}
					</span>
				)}
				<TaskMarks task={task} now={now} />
			</button>
		</li>
	);
}

/** A task moving without you, in one muted line: its name and who has it now. */
function MovingRow({ task, now, picked, open, onShow }: TaskProps) {
	const { Icon, tone } = GROUP_MARK[task.group];
	const waitingOn = task.group === "waiting" ? task.items[0].waitingOn : null;
	const word =
		task.group === "running"
			? "Claude is on it"
			: waitingOn
				? `waiting on ${waitingOn}`
				: todayGroupLabel(task.group).toLowerCase();
	return (
		<li data-today-task={task.id}>
			<button
				type="button"
				title={task.about ?? "Show its summary beside the page"}
				onClick={() => onShow(task.id)}
				className={cn(
					"flex w-full flex-wrap items-baseline gap-x-2 rounded-lg px-3 py-1.5 text-left text-[14px] text-muted-foreground hover:bg-secondary/60",
					open && "bg-primary/10",
					picked && "ring-2 ring-primary/60",
				)}
			>
				<span className="font-medium text-foreground/85">{task.name}</span>
				<span
					className={cn("inline-flex items-center gap-1 text-[12px]", tone)}
				>
					<Icon className="size-3" aria-hidden />
					{word}
				</span>
				<TaskMarks task={task} now={now} />
			</button>
		</li>
	);
}

/**
 * A task's summary beside the page: its action items to answer here, what
 * it is, why it matters, where it stands and who acts next, its sessions,
 * the task it was started from, and Go to session, Done, Snooze and Next.
 */
function TodayTaskPanel({
	task,
	now,
	actions,
	onActed,
	onNext,
	onClose,
}: {
	task: TodayTaskView<TodayItem>;
	now: number;
	actions: TodayActions;
	onActed: () => void;
	onNext?: () => void;
	onClose: () => void;
}) {
	const { Icon, tone } = GROUP_MARK[task.group];
	const waitingOn = task.group === "waiting" ? task.items[0].waitingOn : null;
	const linked = [
		...new Map(
			task.items.flatMap((item) =>
				item.row ? [[item.row.key, item.row]] : [],
			) as [string, AllItem][],
		).values(),
	];
	const parts = (
		[
			["What it is", task.about],
			["Why it matters", task.explain],
			["Where it stands", standing(task)],
			["Next", task.next],
		] as const
	).filter(([, text]) => !!text);
	return (
		<aside
			aria-label="Task summary"
			data-today-panel
			className="flex w-[420px] shrink-0 flex-col border-l border-border"
		>
			<div className="flex shrink-0 items-center gap-2 px-4 pt-2.5 pb-1.5">
				<span
					className={cn(
						"inline-flex items-center gap-1 text-[12px] font-semibold",
						tone,
					)}
				>
					<Icon className="size-3" aria-hidden />
					{waitingOn ? `Waiting on ${waitingOn}` : todayGroupLabel(task.group)}
				</span>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close summary"
					className="ml-auto rounded-[7px] px-2 py-0.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground"
				>
					✕
				</button>
			</div>
			<div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 pb-5">
				<div className="space-y-1">
					<h2 className="select-text cursor-text text-[17px] font-semibold leading-snug">
						{task.name}
					</h2>
					<TaskMarks task={task} now={now} />
				</div>
				<TaskItems task={task} onOpen={actions.onOpen} onSent={onActed} />
				{parts.length === 0 && (
					<p className="text-[13px] text-muted-foreground">
						Claude hasn't written about this task yet.
					</p>
				)}
				{parts.map(([label, text]) => (
					<div key={label}>
						<p className={LABEL}>{label}</p>
						<p className="select-text cursor-text text-[14px] leading-relaxed text-foreground/90">
							{sentence(text)}
						</p>
					</div>
				))}
				{linked.map((row) => (
					<div key={row.key} className="border-t border-border pt-3">
						<p className={LABEL}>Started from</p>
						<TaskDetails item={row} />
					</div>
				))}
			</div>
			<div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-2.5">
				<TaskButtons
					task={task}
					actions={actions}
					onActed={onActed}
					onNext={onNext}
				/>
				{task.items[0].from?.url && (
					<button
						type="button"
						onClick={() => openUrl(task.items[0].from?.url ?? "")}
						className="self-start text-[12px] font-semibold text-muted-foreground hover:text-foreground"
					>
						Open in {task.items[0].from.source} ↗
					</button>
				)}
			</div>
		</aside>
	);
}

/** Your tasks the "Not started yet" list reads, from what Tasks already keeps. */
function useTodaySide() {
	const rows = useAllItems();
	const queue = useTaskMeta((s) => s.queue);
	const waiting = useTaskMeta((s) => s.waiting);
	const reminders = useReminders((s) => s.reminders);
	const panes = useTabsStore((s) => s.panes);
	return useMemo(() => {
		const all = Object.values(panes);
		const sideRows: SideRow[] = rows.map((row) => ({
			key: row.key,
			title: row.title,
			source: row.source,
			url: row.url,
			due: effectiveDue(row.key, reminders, row.dueDate),
			started: livePanesOn(all, row).length > 0,
		}));
		const now = Date.now();
		const side = todaySide({
			rows: sideRows,
			queue,
			waiting,
			daysUntil: (day) => daysUntil(day, now),
		});
		const byKey = new Map(rows.map((row) => [row.key, row]));
		return { ...side, byKey };
	}, [rows, queue, waiting, reminders, panes]);
}

/**
 * Not started yet: tasks no session works on yet - due this week or late, the top
 * of Up next, and what waits on someone else - one line each, with Start
 * and a link to where it came from.
 */
function ComingUp({
	side,
	onOpen,
}: {
	side: ReturnType<typeof useTodaySide>;
	onOpen: (paneId: string) => void;
}) {
	const { start, isLaunching } = useStartAllItem();
	const panes = useTabsStore((s) => s.panes);
	const now = Date.now();
	const hiddenToday = useTaskMeta((s) => s.hiddenToday);
	const hideToday = useTaskMeta((s) => s.hideToday);
	const unhideToday = useTaskMeta((s) => s.unhideToday);
	const hidden = new Set(hiddenToday);
	const shown = (row: { key: string }) => !hidden.has(row.key);
	const due = side.due.filter((row) => !row.started && shown(row));
	const upNext = side.upNext.filter(shown);
	const waiting = side.waiting.filter(shown);
	const hiddenCount = [...side.due, ...side.upNext, ...side.waiting].filter(
		(row) => hidden.has(row.key),
	).length;
	if (!due.length && !upNext.length && !waiting.length && !hiddenCount)
		return null;
	const links = (
		key: string,
		url: string | null,
		source: string | null,
		started: boolean,
	) => {
		const row = side.byKey.get(key);
		const paneId =
			started && row ? livePanesOn(Object.values(panes), row)[0]?.id : null;
		return (
			<>
				{" "}
				{paneId ? (
					<button
						type="button"
						onClick={() => onOpen(paneId)}
						className={cn(LINK, "text-[13px]")}
					>
						Go to session
					</button>
				) : (
					row && (
						<button
							type="button"
							disabled={isLaunching}
							onClick={() => void start(row)}
							className={cn(LINK, "text-[13px]")}
						>
							Start
						</button>
					)
				)}
				{url && (
					<>
						{" · "}
						<button
							type="button"
							onClick={() => openUrl(url)}
							className={cn(LINK, "text-[13px]")}
						>
							Open in {source}
						</button>
					</>
				)}
				{" · "}
				<button
					type="button"
					onClick={() => hideToday(key)}
					className={cn(LINK, "text-[13px] text-muted-foreground")}
				>
					Hide
				</button>
			</>
		);
	};
	return (
		<section
			aria-label="Not started yet"
			className="border-t border-border pt-5 first:border-t-0 first:pt-0"
		>
			<h2 className="mb-2 flex items-baseline gap-3 text-[15px] font-semibold text-muted-foreground">
				Not started yet
				{hiddenCount > 0 && (
					<button
						type="button"
						onClick={unhideToday}
						className={cn(LINK, "text-[13px] font-normal")}
					>
						Show {hiddenCount} hidden
					</button>
				)}
			</h2>
			<ul className="flex list-disc flex-col gap-1.5 pl-5 text-[14px] leading-relaxed marker:text-muted-foreground">
				{due.map((row) => (
					<li key={`due-${row.key}`}>
						<span className="select-text cursor-text">{row.title}</span>
						{" - "}
						<span className={cn("font-medium", dueTone(row.daysLeft))}>
							{dueLabel(row.due ?? "", row.daysLeft).toLowerCase()}
						</span>
						{links(row.key, row.url, row.source, row.started)}
					</li>
				))}
				{upNext.map((row) => (
					<li key={`next-${row.key}`}>
						<span className="select-text cursor-text">{row.title}</span>
						<span className="text-muted-foreground"> - next on Up next</span>
						{links(row.key, row.url, row.source, row.started)}
					</li>
				))}
				{waiting.map((row) => {
					const back = daysUntil(row.until, now);
					return (
						<li key={`wait-${row.key}`}>
							<span className="select-text cursor-text">{row.title}</span>
							<span className="text-muted-foreground">
								{" - "}
								{row.on ? `waiting on ${row.on}` : "waiting"}, back on Up next{" "}
								{back <= 0
									? "today"
									: back === 1
										? "tomorrow"
										: `in ${back} days`}
							</span>
							{links(row.key, row.url, row.source, row.started)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** How long "Sent. Odin is on it." stays under the card. */
const HANDOFF_MS = 2500;

/**
 * Auto pilot: a workspace to stay in. Left, the queue: every task waiting on
 * you (click one to take it now), then the sessions moving without you, and
 * New session. Middle, the task on top: answer it, finish or snooze it and the
 * next one comes up. Right, that task's session, opened by itself, so you see
 * its chat while you answer. The session you answered keeps going on its own.
 * X skips the card to the end, Space opens its session again after you
 * closed it (rebindable in Settings > Keyboard).
 */
function AutoPilot({
	yours,
	moving,
	now,
	openPaneId,
	beside,
	actions,
	onNew,
}: {
	yours: TodayTaskView<TodayItem>[];
	moving: TodayTaskView<TodayItem>[];
	now: number;
	openPaneId?: string;
	/** Width the session drawer takes on the right, while it is open. */
	beside?: string;
	actions: TodayActions;
	onNew?: () => void;
}) {
	const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
	const [skipped, setSkipped] = useState<string[]>([]);
	// A task picked from the queue: it goes before Today's order until handled.
	const [chosen, setChosen] = useState<string | null>(null);
	const [handoff, setHandoff] = useState<string | null>(null);
	// Opening a session counts as seeing it, which takes it out of Waiting on
	// you: a task stays in the queue once it was there, until you act on it,
	// skip it, or Claude works on it again. Otherwise opening the card's
	// session would empty the queue one card at a time.
	const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
	const yoursKey = yours.map((task) => task.id).join(" ");
	useEffect(() => {
		const ids = yoursKey ? yoursKey.split(" ") : [];
		setKept((old) =>
			ids.every((id) => old.has(id)) ? old : new Set([...old, ...ids]),
		);
	}, [yoursKey]);
	const stays = (task: TodayTaskView<TodayItem>) =>
		kept.has(task.id) && task.group !== "running";
	const queued = [...yours, ...moving.filter(stays)];
	const others = moving.filter((task) => !stays(task));
	const ids = queued.map((task) => task.id);
	const idsKey = ids.join(" ");
	// A task that left the queue is forgotten, so it comes back as new the
	// next time its session asks you something.
	useEffect(() => {
		const live = new Set(idsKey.split(" "));
		const keep = <T,>(old: ReadonlySet<T>) => {
			const left = [...old].filter((id) => live.has(String(id)));
			return left.length === old.size ? old : new Set(left);
		};
		setHandled(keep);
		setKept((old) => {
			const fresh = new Set(yoursKey.split(" "));
			const left = [...old].filter((id) => live.has(id) || fresh.has(id));
			return left.length === old.size ? old : new Set(left);
		});
		setSkipped((old) => {
			const left = old.filter((id) => live.has(id));
			return left.length === old.length ? old : left;
		});
	}, [idsKey, yoursKey]);
	useEffect(() => {
		if (!handoff) return;
		const timer = setTimeout(() => setHandoff(null), HANDOFF_MS);
		return () => clearTimeout(timer);
	}, [handoff]);
	const pick =
		chosen && ids.includes(chosen) && !handled.has(chosen)
			? chosen
			: pilotPick(ids, handled, skipped);
	const task = queued.find((t) => t.id === pick) ?? null;
	const left = ids.filter((id) => !handled.has(id)).length;
	// The card's session opens beside it by itself, once per card: close it
	// and it stays closed until the next card comes up.
	const firstKey = task?.items[0].key ?? null;
	const openedFor = useRef<string | null>(null);
	useEffect(() => {
		if (!pick || !firstKey || openedFor.current === pick) return;
		openedFor.current = pick;
		if (openPaneId !== firstKey) actions.onOpen(firstKey);
	}, [pick, firstKey, openPaneId, actions]);
	const acted = (id: string) => {
		setHandled((old) => new Set(old).add(id));
		if (chosen === id) setChosen(null);
		setHandoff("Sent. Odin is on it.");
	};
	const skip = (id: string) => {
		setSkipped((old) => [...old.filter((s) => s !== id), id]);
		if (chosen === id) setChosen(null);
		setHandoff("Skipped. It comes back at the end.");
	};
	const keys = {
		enableOnFormTags: false,
		enableOnContentEditable: false,
		enabled: !!task,
	};
	useHotkey(
		"PILOT_PEEK",
		() => task && actions.onOpen(task.items[0].key),
		keys,
	);
	useHotkey("PILOT_SKIP", () => task && skip(task.id), keys);
	const peekKey = useHotkeyDisplay("PILOT_PEEK").text;
	const skipKey = useHotkeyDisplay("PILOT_SKIP").text;
	const queue = ids.filter((id) => !handled.has(id));
	return (
		<section
			aria-label="Auto pilot"
			data-testid="auto-pilot"
			className="flex min-h-0 flex-1"
			style={{ paddingRight: beside }}
		>
			<nav
				aria-label="Queue"
				className="flex w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border px-3 pb-6 pt-5"
			>
				<header className="flex items-center gap-2 px-2">
					<h1 className="inline-flex items-center gap-2 whitespace-nowrap text-[18px] font-semibold tracking-[-.3px]">
						<LuPlane className="size-4 text-primary-ink" aria-hidden />
						Auto pilot
					</h1>
					{onNew && (
						<button
							type="button"
							title="New session - describe a task and start an agent session"
							onClick={onNew}
							className={cn(
								"ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-[7px] px-2 py-1 text-[12px] font-semibold",
								BUTTON.secondary,
							)}
						>
							<LuPlus className="size-3" aria-hidden />
							New session
						</button>
					)}
				</header>
				<div className="flex flex-col gap-1">
					<p className={cn(LABEL, "px-2")}>Needs you · {left}</p>
					{queue.length === 0 && (
						<p className="px-2 text-[13px] text-muted-foreground">
							Nothing right now.
						</p>
					)}
					<ol className="flex flex-col">
						{queue.map((id, i) => {
							const row = queued.find((t) => t.id === id);
							if (!row) return null;
							return (
								<li key={id}>
									<button
										type="button"
										title="Take this one now"
										onClick={() => setChosen(id)}
										className={cn(
											"flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] leading-snug hover:bg-secondary/60",
											id === pick && "bg-primary/15 font-semibold",
										)}
									>
										<span className="w-4 shrink-0 text-[12px] font-semibold text-attention">
											{i + 1}
										</span>
										<span className="min-w-0 flex-1 truncate">{row.name}</span>
										{skipped.includes(id) && (
											<span className="text-[11px] text-muted-foreground">
												skipped
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ol>
				</div>
				{others.length > 0 && (
					<div className="flex flex-col gap-1">
						<p className={cn(LABEL, "px-2")}>
							Moving without you · {others.length}
						</p>
						<ol className="flex flex-col">
							{others.map((row) => {
								const { Icon, tone } = GROUP_MARK[row.group];
								const key = row.items[0].key;
								return (
									<li key={row.id}>
										<button
											type="button"
											title={`${todayGroupLabel(row.group)} - open its session beside this`}
											onClick={() => actions.onOpen(key)}
											className={cn(
												"flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] text-muted-foreground hover:bg-secondary/60",
												row.items.some((item) => item.key === openPaneId) &&
													"bg-primary/10 text-foreground",
											)}
										>
											<Icon
												className={cn("size-3 shrink-0", tone)}
												aria-hidden
											/>
											<span className="min-w-0 flex-1 truncate">
												{row.name}
											</span>
										</button>
									</li>
								);
							})}
						</ol>
					</div>
				)}
			</nav>
			<div className="@container min-w-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-5 pb-10 pt-5">
					{task ? (
						<ol>
							<StartHere
								key={task.id}
								task={task}
								now={now}
								picked={false}
								open={task.items.some((item) => item.key === openPaneId)}
								actions={actions}
								onShow={() => actions.onOpen(task.items[0].key)}
								onActed={() => acted(task.id)}
								onSkip={() => skip(task.id)}
							/>
						</ol>
					) : (
						<div className="flex flex-col gap-1 rounded-xl border border-border px-5 py-4">
							<p className="text-[17px] font-semibold text-success-ink">
								All clear
							</p>
							<p className="text-[14px] text-muted-foreground">
								Nothing needs you right now. The next task comes up here as soon
								as a session asks you something.
							</p>
						</div>
					)}
					<p
						aria-live="polite"
						className="min-h-5 text-[13px] font-medium text-success-ink"
					>
						{handoff}
					</p>
					{task && (
						<p className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
							<span>
								<kbd className={KBD}>{peekKey}</kbd> open its session again
							</span>
							<span>
								<kbd className={KBD}>{skipKey}</kbd> skip to the end
							</span>
						</p>
					)}
				</div>
			</div>
		</section>
	);
}

const KBD =
	"rounded border border-border border-b-2 bg-card px-1 font-mono text-[11px]";
