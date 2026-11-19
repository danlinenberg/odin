import { cn } from "@odin/ui/utils";
import type { ComponentType, ReactNode } from "react";
import { useMemo, useState } from "react";
import {
	LuCircleCheck,
	LuHourglass,
	LuLoaderCircle,
	LuMessageCircleQuestion,
	LuPause,
	LuPlay,
	LuRefreshCw,
} from "react-icons/lu";
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { openUrl } from "renderer/stores/in-app-browser";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useTodayOverview } from "renderer/stores/today-overview";
import { livePanesOn, urgencyOf } from "../all/all-items";
import { useTaskMeta } from "../all/task-meta";
import { useAllItems } from "../all/use-all-items";
import { useStartAllItem } from "../all/use-start-item";
import { BUTTON } from "../components/pill";
import { daysUntil, effectiveDue, useReminders } from "../components/Reminders";
import {
	dueLabel,
	type TodayEntry,
	type TodayGroup,
	type TodaySignals,
	type TodayTaskView,
	todayCounts,
	todayGroup,
	todayGroupLabel,
	todayLanes,
	todayTasks,
	yourAction,
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
	onOpen,
}: {
	cards: TodayCard[];
	/** The session open beside the page: its task is marked. */
	openPaneId?: string;
	onOpen: (paneId: string) => void;
}) {
	const items = useTodayItems(cards);
	const [refresh, setRefresh] = useState(0);
	const { data, isFetching } =
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
	const lanes = useMemo(
		() => todayLanes(todayTasks(data?.tasks ?? [], items)),
		[data, items],
	);
	// Arrow keys walk the page top to bottom: your lane, then the other.
	const tasks = useMemo(() => [...lanes.yours, ...lanes.moving], [lanes]);
	const side = useTodaySide();
	const enabled = useTodayOverview((s) => s.enabled);
	const setEnabled = useTodayOverview((s) => s.setEnabled);
	const now = Date.now();
	const dateLine = new Date(now).toLocaleDateString(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
	});

	// Today: Next / Previous Task move between tasks, Open Task opens the
	// picked one's first session (down, up and Enter unless rebound).
	const [selected, setSelected] = useState(-1);
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
			if (task) onOpen(task.id);
		},
		{ ...keys, enabled: selected >= 0 },
	);

	return (
		<section
			aria-label="Today"
			data-testid="today-overview"
			className="@container flex min-h-0 flex-1 flex-col overflow-y-auto"
		>
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
								"ml-auto inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[11.5px] font-semibold disabled:opacity-50",
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
								<span className="text-[12.5px] text-muted-foreground">
									do these first
								</span>
							</h2>
							{lanes.yours.length === 0 ? (
								<p className="text-[14px] text-muted-foreground">
									Nothing waits on you right now.
								</p>
							) : (
								<ol className="flex flex-col gap-4">
									{lanes.yours.map((task, i) => (
										<YourTask
											key={task.id}
											task={task}
											number={i + 1}
											now={now}
											picked={tasks[selected]?.id === task.id}
											open={task.items.some((item) => item.key === openPaneId)}
											onOpen={onOpen}
										/>
									))}
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
										<span className="text-[12.5px] text-muted-foreground">
											nothing to do, just so you know
										</span>
									</h2>
									<ul className="flex flex-col gap-5">
										{lanes.moving.map((task) => (
											<MovingTask
												key={task.id}
												task={task}
												now={now}
												picked={tasks[selected]?.id === task.id}
												open={task.items.some(
													(item) => item.key === openPaneId,
												)}
												onOpen={onOpen}
											/>
										))}
									</ul>
								</section>
							)}
							<ComingUp side={side} onOpen={onOpen} />
						</div>
					</div>
				)}
				{tasks.length === 0 && <ComingUp side={side} onOpen={onOpen} />}

				<label className="flex items-center gap-2 border-t border-border pt-3 text-[11.5px] text-muted-foreground">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(event) => setEnabled(event.target.checked)}
					/>
					Show this every morning when Odin opens (the Today icon opens it any
					time)
				</label>
			</div>
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

/** Its due date, a high priority and its star, as short words after the text. */
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
	return (
		<>
			{due && left !== null && (
				<span className={cn("font-semibold", dueTone(left))}>
					{" "}
					{dueLabel(due, left)}.
				</span>
			)}
			{high && (
				<span className="font-semibold text-danger-ink">
					{" "}
					{high.priority ?? "High"} priority.
				</span>
			)}
			{starred && <span className="text-attention-ink"> ★ Starred.</span>}
		</>
	);
}

type TaskProps = {
	task: TodayTaskView<TodayItem>;
	now: number;
	/** Picked with the arrow keys. */
	picked: boolean;
	/** One of its sessions is open beside the page. */
	open: boolean;
	onOpen: (paneId: string) => void;
};

const rowClass = (open: boolean, picked: boolean) =>
	cn(
		"-mx-3 rounded-lg px-3 py-1.5",
		open && "bg-primary/10",
		picked && "ring-2 ring-primary/60",
	);

/** A small label over a block of a task's text. */
const LABEL =
	"mb-0.5 text-[11px] font-semibold uppercase tracking-[.06em] text-muted-foreground";

/**
 * A task waiting on you, numbered in the order to do it: what you do as its
 * title, the task's name with its due date and priority, then side by side
 * when there is room an Explanation of what the task is and Where it stands,
 * and its sessions.
 */
function YourTask({
	task,
	number,
	now,
	picked,
	open,
	onOpen,
}: TaskProps & { number: number }) {
	const action = yourAction(task.next);
	const fallback =
		task.group === "almost-done" ? `Finish: ${task.name}` : task.name;
	// What the task is about, in a line under the title: its name with what
	// it is, or only what it is when the name is already the title.
	const about = action
		? [task.name, sentence(task.about)].filter(Boolean).join(": ")
		: sentence(task.about);
	const explain = task.explain;
	const stands =
		[task.line, task.left].map(sentence).filter(Boolean).join(" ") ||
		todayGroupLabel(task.group);
	return (
		<li
			data-today-task={task.id}
			className={cn(
				"@container grid grid-cols-[26px_1fr] gap-x-2 rounded-xl border border-border bg-card/40 px-4 py-3.5",
				open && "border-primary/50 bg-primary/10",
				picked && "ring-2 ring-primary/60",
			)}
		>
			<span className="text-[17px] font-semibold leading-snug text-attention">
				{number}
			</span>
			<div className="flex min-w-0 flex-col gap-2.5">
				<div>
					<button
						type="button"
						title="Open its session beside this page"
						onClick={() => onOpen(task.items[0].key)}
						className="text-left text-[16px] font-semibold leading-snug underline-offset-2 hover:underline"
					>
						{action ?? fallback}
					</button>
					{about && (
						<p className="mt-1 select-text cursor-text text-[13.5px] font-medium leading-snug text-foreground/90">
							{about}
							<TaskMarks task={task} now={now} />
						</p>
					)}
				</div>
				<div className="grid select-text cursor-text gap-x-6 gap-y-2.5 text-[13.5px] leading-relaxed @2xl:grid-cols-2">
					{explain && (
						<div>
							<p className={LABEL}>Explanation</p>
							<p className="text-foreground/90">{sentence(explain)}</p>
						</div>
					)}
					<div>
						<p className={LABEL}>Where it stands</p>
						<p className="text-foreground/90">
							{stands}
							{!about && <TaskMarks task={task} now={now} />}
						</p>
					</div>
				</div>
				<SessionLines task={task} onOpen={onOpen} />
			</div>
		</li>
	);
}

/**
 * A task moving without you: its name and who has it now, then what it is,
 * where it stands, what is left and who acts next, and its sessions.
 */
function MovingTask({ task, now, picked, open, onOpen }: TaskProps) {
	const { Icon, tone } = GROUP_MARK[task.group];
	const waitingOn = task.group === "waiting" ? task.items[0].waitingOn : null;
	const word =
		task.group === "running"
			? "Claude is on it"
			: waitingOn
				? `waiting on ${waitingOn}`
				: todayGroupLabel(task.group).toLowerCase();

	const prose = [task.line, task.left, task.next]
		.map(sentence)
		.filter(Boolean)
		.join(" ");
	return (
		<li data-today-task={task.id} className={rowClass(open, picked)}>
			<p className="flex flex-wrap items-baseline gap-x-2">
				<button
					type="button"
					title="Open its session beside this page"
					onClick={() => onOpen(task.items[0].key)}
					className="text-left text-[14.5px] font-semibold underline-offset-2 hover:underline"
				>
					{task.name}
				</button>
				<span
					className={cn("inline-flex items-center gap-1 text-[12px]", tone)}
				>
					<Icon className="size-3" aria-hidden />
					{word}
				</span>
			</p>
			{task.about && (
				<p className="mt-1 select-text cursor-text text-[13.5px] font-medium leading-snug text-foreground/90">
					{sentence(task.about)}
				</p>
			)}
			{task.explain && (
				<p className="mt-1 select-text cursor-text text-[13.5px] leading-relaxed text-foreground/85">
					{sentence(task.explain)}
				</p>
			)}
			{(prose || task.items.some((item) => item.due || item.starred)) && (
				<p className="mt-1 select-text cursor-text text-[13px] leading-relaxed text-muted-foreground">
					{prose}
					<TaskMarks task={task} now={now} />
				</p>
			)}
			<div className="mt-1">
				<SessionLines task={task} onOpen={onOpen} />
			</div>
		</li>
	);
}

/**
 * A line per session: its title (opens it), where it stands when the task
 * has several, its facts - where it runs, repo, last message, pull requests -
 * and the task it came from.
 */
function SessionLines({
	task,
	onOpen,
}: {
	task: TodayTaskView<TodayItem>;
	onOpen: (paneId: string) => void;
}) {
	return (
		<ul className="flex flex-col gap-1 border-l-2 border-border pl-3 text-[12px] text-muted-foreground">
			{task.items.map((item) => (
				<li
					key={item.key}
					className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
				>
					<button
						type="button"
						title={`${todayGroupLabel(item.group)} - open it beside this page`}
						onClick={() => onOpen(item.key)}
						className={cn(LINK, "text-[12.5px]")}
					>
						{item.title}
					</button>
					{task.items.length > 1 && (
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
					{item.from && (
						<span>
							- from {item.from.source}:{" "}
							{item.from.url ? (
								<button
									type="button"
									title={`Open it in ${item.from.source}`}
									onClick={() => openUrl(item.from?.url ?? "")}
									className="text-link hover:underline"
								>
									{item.from.title}
								</button>
							) : (
								item.from.title
							)}
						</span>
					)}
				</li>
			))}
		</ul>
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
	const due = side.due.filter((row) => !row.started);
	const upNext = side.upNext;
	const waiting = side.waiting;
	if (!due.length && !upNext.length && !waiting.length) return null;
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
						className={cn(LINK, "text-[12.5px]")}
					>
						Go to session
					</button>
				) : (
					row && (
						<button
							type="button"
							disabled={isLaunching}
							onClick={() => void start(row)}
							className={cn(LINK, "text-[12.5px]")}
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
							className={cn(LINK, "text-[12.5px]")}
						>
							Open in {source}
						</button>
					</>
				)}
			</>
		);
	};
	return (
		<section
			aria-label="Not started yet"
			className="border-t border-border pt-5 first:border-t-0 first:pt-0"
		>
			<h2 className="mb-2 text-[15px] font-semibold text-muted-foreground">
				Not started yet
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
