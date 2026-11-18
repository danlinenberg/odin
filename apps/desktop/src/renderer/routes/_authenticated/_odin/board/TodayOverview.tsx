import { cn } from "@odin/ui/utils";
import type { ComponentType, ReactNode } from "react";
import { Fragment, useMemo, useState } from "react";
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
	todayTasks,
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

/** A mark under a task: a dot after it parts it from the next one. */
const MARK = "after:ml-1.5 after:text-muted-foreground after:content-['·']";

const LINK =
	"font-medium text-primary-ink underline-offset-2 hover:underline disabled:opacity-50";

/** Overdue and due within a day stand out; later dates read as plain text. */
const dueTone = (left: number) =>
	left < 0 ? "text-danger-ink" : left <= 1 ? "text-attention-ink" : "";

/**
 * Today: your open work as one page of plain text. A sentence over all of
 * it, then every task you are working on - the board's sessions grouped by
 * Claude into the work they serve - with what it is, where it stands, how
 * much is left, its due date and priority, and links to its sessions. Under
 * it, your tasks coming up that no session works on yet. No cards, no
 * columns: Board view has those.
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
	const tasks = useMemo(
		() => todayTasks(data?.tasks ?? [], items),
		[data, items],
	);
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
			className="flex min-h-0 flex-1 flex-col overflow-y-auto"
		>
			<div className="mx-auto flex w-full max-w-[780px] flex-col gap-6 px-6 pb-8 pt-4">
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
					<p className="select-text cursor-text text-[15px] leading-relaxed">
						{data?.summary ?? `${todayCounts(items)}.`}
					</p>
					{isFetching && !data && items.length > 0 && (
						<p className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
							<LuLoaderCircle className="size-3 animate-spin" />
							Writing it in plain words...
						</p>
					)}
				</header>

				<section aria-label="What you're working on">
					<h2 className="mb-3 text-[15px] font-semibold">
						What you're working on
					</h2>
					{tasks.length === 0 ? (
						<p className="text-[14px] text-muted-foreground">
							No open sessions. Start one from Tasks, or from the board.
						</p>
					) : (
						<ul className="flex flex-col gap-7">
							{tasks.map((task, i) => (
								<TodayTaskText
									key={task.id}
									task={task}
									now={now}
									picked={i === selected}
									open={task.items.some((item) => item.key === openPaneId)}
									onOpen={onOpen}
								/>
							))}
						</ul>
					)}
				</section>

				<ComingUp side={side} onOpen={onOpen} />

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

/**
 * One task as a few lines of text: its name and what it is; where it
 * stands, what is left and who acts next; where it stands in one word, its
 * due date and priority; then a line per session with where it runs, its
 * repo, its last message, its pull requests and the task it came from.
 */
function TodayTaskText({
	task,
	now,
	picked,
	open,
	onOpen,
}: {
	task: TodayTaskView<TodayItem>;
	now: number;
	/** Picked with the arrow keys. */
	picked: boolean;
	/** One of its sessions is open beside the page. */
	open: boolean;
	onOpen: (paneId: string) => void;
}) {
	const { Icon, tone } = GROUP_MARK[task.group];
	const first = task.items[0];
	const due = task.items
		.map((item) => item.due)
		.filter((day): day is string => !!day)
		.sort()[0];
	const left = due ? daysUntil(due, now) : null;
	const high = task.items.find((item) => item.urgency === "high");
	const waitingOn = task.group === "waiting" ? first.waitingOn : null;
	const marks: ReactNode[] = [
		<span
			key="group"
			className={cn("inline-flex items-center gap-1", tone, MARK)}
		>
			<Icon className="size-3" aria-hidden />
			{waitingOn ? `Waiting on ${waitingOn}` : todayGroupLabel(task.group)}
		</span>,
	];
	if (due && left !== null)
		marks.push(
			<span key="due" className={cn("font-medium", dueTone(left), MARK)}>
				{dueLabel(due, left)}
			</span>,
		);
	if (high)
		marks.push(
			<span key="priority" className={cn("font-medium text-danger-ink", MARK)}>
				{high.priority ?? "High"} priority
			</span>,
		);
	if (task.items.some((item) => item.starred))
		marks.push(
			<span key="star" className={cn("text-attention-ink", MARK)}>
				★ Starred
			</span>,
		);
	return (
		<li
			data-today-task={task.id}
			className={cn(
				"-mx-3 rounded-lg px-3 py-1.5",
				open && "bg-primary/10",
				picked && "ring-2 ring-primary/60",
			)}
		>
			<p className="text-[15px] leading-relaxed">
				<button
					type="button"
					title="Open its session beside this page"
					onClick={() => onOpen(first.key)}
					className="text-left font-semibold underline-offset-2 hover:underline"
				>
					{task.name}
				</button>
			</p>
			<dl className="mt-1 grid select-text cursor-text grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[13.5px] leading-relaxed">
				{(
					[
						["What it is", task.about],
						["Where it stands", task.line],
						["What's left", task.left],
						["Next", task.next],
					] as const
				).map(([label, text]) =>
					text ? (
						<Fragment key={label}>
							<dt className="text-muted-foreground">{label}</dt>
							<dd>{text}</dd>
						</Fragment>
					) : null,
				)}
			</dl>
			<p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted-foreground">
				{marks}
				<span>
					{task.items.length === 1
						? "1 session"
						: `${task.items.length} sessions`}
				</span>
			</p>
			<ul className="mt-1 flex flex-col gap-1 border-l-2 border-border pl-3 text-[12px] text-muted-foreground">
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
		</li>
	);
}

/** Your tasks the "Coming up" list reads, from what Tasks already keeps. */
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
 * Coming up: tasks no session works on yet - due this week or late, the top
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
		<section aria-label="Coming up">
			<h2 className="mb-2 text-[15px] font-semibold">Coming up</h2>
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
