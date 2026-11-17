import { cn } from "@odin/ui/utils";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	LuCalendarClock,
	LuChevronDown,
	LuChevronRight,
	LuCircleCheck,
	LuHourglass,
	LuListOrdered,
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
import { BUTTON, PILL } from "../components/pill";
import { daysUntil, effectiveDue, useReminders } from "../components/Reminders";
import {
	bangCommandNotes,
	bangCommands,
	downloadPath,
	localCommand,
	noActionItems,
	splitActionItems,
	viewTarget,
} from "./action-items";
import {
	ActionItems,
	CommandNotes,
	runInClaudePrompt,
	runSessionCommand,
} from "./ChatView";
import {
	dueLabel,
	plainLine,
	pressTodayChip,
	TODAY_GROUPS,
	type TodayEntry,
	type TodayGroup,
	type TodaySignals,
	todayCounts,
	todayGroup,
	todayGroupLabel,
	todaySections,
	toggleTodayGroup,
} from "./today";
import { moveSelection, type SideRow, todaySide } from "./today-side";

/** A board session, as the board hands it to the overview. */
export interface TodayCard {
	/** The board pane - a click opens it. */
	paneId: string;
	title: string;
	sessionId: string | null;
	/** The brief's status line, shown until the plain line is written. */
	status: string | null;
	starred: boolean;
	signals: TodaySignals;
	workspaceId: string;
	/** Claude runs in its pane now: a `!` command can be typed into it. */
	live: boolean;
	/** The board's own pills for it: repo, host, last activity, PRs, tags. */
	meta?: ReactNode;
	/** The board's own buttons for it: Star, Done, Remind me, Start now. */
	actions?: ReactNode;
}

/** One open session as the overview lists it. */
export interface TodayItem extends TodayEntry {
	key: string;
	title: string;
	sessionId: string | null;
	status: string | null;
	waitingOn: string | null;
	/** The linked task's priority as its source names it. */
	priority: string | null;
}

/**
 * The board's cards with what Tasks knows about each one's task: its due
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
			};
		});
	}, [cards, rows, panes, waiting, reminders]);
}

const GROUP_ICON: Record<
	TodayGroup,
	{ Icon: ComponentType<{ className?: string }>; tone: string }
> = {
	"needs-you": { Icon: LuMessageCircleQuestion, tone: "text-attention" },
	"almost-done": { Icon: LuCircleCheck, tone: "text-success" },
	running: { Icon: LuPlay, tone: "text-working" },
	waiting: { Icon: LuHourglass, tone: "text-primary" },
	paused: { Icon: LuPause, tone: "text-muted-foreground" },
};

const MARK = "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium";
const BTN = "shrink-0 rounded-[7px] px-2.5 py-1 text-[11.5px] font-semibold";
const CHIP =
	"inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium transition-opacity";
/** A chip that is on: its group shows, or the due filter applies. */
const CHIP_ON = BUTTON.selected;
/** A chip that is off: dimmed, so a hidden group reads as hidden. */
const CHIP_OFF =
	"bg-transparent text-muted-foreground ring-1 ring-inset ring-border opacity-60 hover:opacity-100";

const groupId = (group: TodayGroup) => `today-${group}`;

const jump = (id: string) =>
	document
		.getElementById(id)
		?.scrollIntoView({ behavior: "smooth", block: "start" });

/**
 * Today: your open work in plain words on a page of its own. Sessions sit in
 * the main column by where each stands, each a card with what it is, where
 * it runs, its PRs and the buttons to move it; the side column lists your
 * tasks that are due, the top of Up next and what waits on someone else.
 */
export function TodayOverview({
	cards,
	onOpen,
	onSend,
}: {
	cards: TodayCard[];
	onOpen: (paneId: string) => void;
	/** Text to a session: typed into a live Claude, else resumes it with it. */
	onSend: (paneId: string, text: string) => void;
}) {
	const items = useTodayItems(cards);
	const cardOf = useMemo(
		() => new Map(cards.map((card) => [card.paneId, card])),
		[cards],
	);
	const hidden = useTodayOverview((s) => s.hidden);
	const setHidden = useTodayOverview((s) => s.setHidden);
	const dueOnly = useTodayOverview((s) => s.dueOnly);
	const setDueOnly = useTodayOverview((s) => s.setDueOnly);
	const sections = todaySections(items, { hidden, dueOnly });
	const layout = useTodayOverview((s) => s.layout);
	const setLayout = useTodayOverview((s) => s.setLayout);
	const columns = layout === "columns";
	// Every session in page order, one bullet each, whatever the chips hide.
	const bullets = todaySections(items, { hidden: [], dueOnly: false }).flatMap(
		(section) => section.items,
	);
	const dueCount = items.filter((item) => !!item.due).length;
	// The header stays pinned: its height keeps a jump's section, and the side
	// column, below it.
	const head = useRef<HTMLElement>(null);
	const [headHeight, setHeadHeight] = useState(0);
	useEffect(() => {
		const el = head.current;
		if (!el) return;
		const observer = new ResizeObserver(() => setHeadHeight(el.offsetHeight));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const pressChip = (group: TodayGroup) => {
		const next = pressTodayChip(hidden, group);
		setHidden(next.hidden);
		if (next.jump) requestAnimationFrame(() => jump(groupId(group)));
	};
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
	const briefClosed = useTodayOverview((s) => s.briefClosed);
	const setBriefClosed = useTodayOverview((s) => s.setBriefClosed);
	const side = useTodaySide();
	const enabled = useTodayOverview((s) => s.enabled);
	const setEnabled = useTodayOverview((s) => s.setEnabled);
	const now = Date.now();
	const dateLine = new Date(now).toLocaleDateString(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
	});

	// Today: Next / Previous Card move between session cards, Open Card opens
	// the picked one (down, up and Enter unless rebound in Settings -> Keyboard).
	const order = sections.flatMap(({ items: rows }) => rows.map((r) => r.key));
	const [selected, setSelected] = useState(-1);
	const step = (by: 1 | -1) => {
		const next = moveSelection(by, selected, order.length);
		if (next === null) return;
		setSelected(next);
		document
			.querySelector(`[data-today-row="${order[next]}"]`)
			?.scrollIntoView({ block: "nearest" });
	};
	const keys = { enableOnFormTags: false, enableOnContentEditable: false };
	useHotkey("TODAY_NEXT", () => step(1), keys);
	useHotkey("TODAY_PREV", () => step(-1), keys);
	useHotkey(
		"TODAY_OPEN",
		() => {
			const key = order[selected];
			if (key) onOpen(key);
		},
		{ ...keys, enabled: selected >= 0 },
	);
	const selectedKey = order[selected];

	return (
		<section
			aria-label="Today"
			data-testid="today-overview"
			style={{ "--today-head": `${headHeight}px` } as CSSProperties}
			className={cn(
				"flex min-h-0 flex-col overflow-y-auto px-[18px]",
				// Columns: the header and its bullets on top, the board's columns
				// below take the rest.
				columns ? "max-h-[45vh] shrink-0" : "flex-1 pb-[18px]",
			)}
		>
			<header
				ref={head}
				className="sticky top-0 z-10 -mx-[18px] mb-4 flex flex-col gap-2 border-b border-border bg-background px-[18px] pb-3 pt-2"
			>
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<h1 className="text-[19px] font-semibold tracking-[-.2px]">Today</h1>
					<span className="text-xs text-muted-foreground">{dateLine}</span>
					<fieldset
						aria-label="Today layout"
						className="ml-auto inline-flex gap-1 border-0 p-0"
					>
						{(["cards", "columns"] as const).map((value) => (
							<button
								key={value}
								type="button"
								aria-pressed={layout === value}
								title={
									value === "cards"
										? "Show each session as a detailed card"
										: "Show the board's columns under the summary"
								}
								onClick={() => setLayout(value)}
								className={cn(CHIP, layout === value ? CHIP_ON : CHIP_OFF)}
							>
								{value === "cards" ? "Cards" : "Columns"}
							</button>
						))}
					</fieldset>
					<button
						type="button"
						title="Write the plain-words lines again from the sessions' newest briefs"
						disabled={!items.length || isFetching}
						onClick={() => setRefresh(Date.now())}
						className={cn(
							BTN,
							BUTTON.secondary,
							"inline-flex items-center gap-1.5 disabled:opacity-50",
						)}
					>
						<LuRefreshCw
							className={cn("size-3", isFetching && "animate-spin")}
							aria-hidden
						/>
						Refresh
					</button>
				</div>
				<div className="select-text cursor-text text-[14px] leading-relaxed">
					{data?.summary ?? `${todayCounts(items)}.`}
					{isFetching && !data && (
						<span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
							<LuLoaderCircle className="size-3 animate-spin" />
							Writing it in plain words...
						</span>
					)}
				</div>
				{bullets.length > 0 && (
					<ul className="select-text list-disc space-y-0.5 pl-5 text-[13px] leading-snug">
						{bullets.map((item) => (
							<li key={item.key}>
								<button
									type="button"
									onClick={() => onOpen(item.key)}
									className="font-semibold hover:underline"
								>
									{item.title}
								</button>
								<span className="text-muted-foreground">
									{" - "}
									{data?.lines[item.key] ?? plainLine(item.status)}
								</span>
							</li>
						))}
					</ul>
				)}
				<div className={cn("flex flex-wrap gap-1.5", columns && "hidden")}>
					{sections.map(({ group: id, count, hidden: off }) => {
						const { Icon, tone } = GROUP_ICON[id];
						const label = todayGroupLabel(id);
						return (
							<button
								key={id}
								type="button"
								aria-pressed={!off}
								title={off ? `Show ${label} and jump to it` : `Hide ${label}`}
								onClick={() => pressChip(id)}
								className={cn(CHIP, off ? CHIP_OFF : CHIP_ON)}
							>
								<Icon className={cn("size-3", tone)} />
								{label} {count}
							</button>
						);
					})}
					<button
						type="button"
						aria-pressed={dueOnly}
						title={
							dueOnly
								? "Show every card again"
								: "Show only cards with a due date, in every group"
						}
						onClick={() => setDueOnly(!dueOnly)}
						className={cn(CHIP, dueOnly ? CHIP_ON : CHIP_OFF)}
					>
						<LuCalendarClock className="size-3 text-danger" />
						Due or overdue {dueCount}
					</button>
				</div>
			</header>
			{!!data?.brief.length && (
				<section
					aria-label="What we're working on"
					className="mb-4 rounded-xl border border-border bg-card/60 px-3.5 py-2.5"
				>
					<button
						type="button"
						aria-expanded={!briefClosed}
						title={briefClosed ? "Show the brief" : "Hide the brief"}
						onClick={() => setBriefClosed(!briefClosed)}
						className="flex w-full items-center gap-2 text-left"
					>
						{briefClosed ? (
							<LuChevronRight className="size-3.5 text-muted-foreground" />
						) : (
							<LuChevronDown className="size-3.5 text-muted-foreground" />
						)}
						<h2 className="text-[13.5px] font-semibold">
							What we're working on
						</h2>
					</button>
					{!briefClosed && (
						<ul className="mt-1.5 list-disc select-text cursor-text space-y-0.5 pl-9 text-[13px] leading-relaxed text-soft-foreground">
							{data.brief.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					)}
				</section>
			)}
			<div
				className={cn(
					"flex min-w-0 flex-col gap-5 lg:flex-row lg:items-start",
					columns && "hidden",
				)}
			>
				<div className="flex min-w-0 flex-1 flex-col gap-5">
					{TODAY_GROUPS.map(({ id, label, hint }) => {
						const section = sections.find((g) => g.group === id);
						const rows = section?.items ?? [];
						const off = !!section?.hidden;
						const { Icon, tone } = GROUP_ICON[id];
						const Chevron = off ? LuChevronRight : LuChevronDown;
						return (
							<section key={id} id={groupId(id)} className={SCROLL_MARGIN}>
								<button
									type="button"
									aria-expanded={!off}
									title={off ? `Show ${label}` : `Hide ${label}`}
									onClick={() => setHidden(toggleTodayGroup(hidden, id))}
									className={cn(
										"flex w-full items-baseline gap-2 text-left",
										!off && "mb-2",
									)}
								>
									<Chevron className="size-3.5 self-center text-muted-foreground" />
									<Icon className={cn("size-4 self-center", tone)} />
									<h2 className="text-[13.5px] font-semibold">
										{label} ({section?.count ?? 0})
									</h2>
									{off ? (
										<span className="text-[12px] italic text-muted-foreground">
											hidden
										</span>
									) : (
										<span className="text-[12px] text-muted-foreground">
											{hint}
										</span>
									)}
								</button>
								{off ? null : rows.length === 0 ? (
									<div className="rounded-lg border border-dashed border-border px-3 py-2.5 text-[12.5px] text-muted-foreground">
										{dueOnly ? "No card here has a due date." : EMPTY[id]}
									</div>
								) : (
									<ul className="flex flex-col gap-2">
										{rows.map((item) => {
											const card = cardOf.get(item.key);
											if (!card) return null;
											return (
												<TodayRow
													key={item.key}
													item={item}
													card={card}
													line={data?.lines[item.key] ?? plainLine(item.status)}
													about={data?.about[item.key] ?? null}
													now={now}
													selected={selectedKey === item.key}
													onSelect={() => setSelected(order.indexOf(item.key))}
													onOpen={() => onOpen(item.key)}
													onSend={(text) => onSend(item.key, text)}
												/>
											);
										})}
									</ul>
								)}
							</section>
						);
					})}
				</div>
				<TodaySideColumn side={side} onOpen={onOpen} />
			</div>
			<label
				className={cn(
					"mt-6 flex items-center gap-2 border-t pt-2 text-[11.5px] text-muted-foreground",
					columns && "hidden",
				)}
			>
				<input
					type="checkbox"
					checked={enabled}
					onChange={(event) => setEnabled(event.target.checked)}
				/>
				Show this every morning when Odin opens (the Today icon opens it any
				time)
			</label>
		</section>
	);
}

/** A jump lands a section just below the pinned header. */
const SCROLL_MARGIN = "scroll-mt-[calc(var(--today-head,0px)+8px)]";

const EMPTY: Record<TodayGroup, string> = {
	"needs-you": "Nothing waits on you.",
	"almost-done": "Nothing is one step from done.",
	running: "No session is working right now.",
	waiting: "Nothing waits on someone else.",
	paused: "Nothing is on hold.",
};

/**
 * One session as a card: what it is and why, where it stands, where it runs and its PRs
 * (the board's own pills), its marks, the buttons to move it, and a reply
 * box. A Needs you card also lists the session's open action items with the
 * same buttons the chat view gives them.
 */
function TodayRow({
	item,
	card,
	line,
	about,
	now,
	selected,
	onSelect,
	onOpen,
	onSend,
}: {
	item: TodayItem;
	card: TodayCard;
	line: string;
	/** What the work is and why, in plain words. */
	about: string | null;
	now: number;
	selected: boolean;
	onSelect: () => void;
	onOpen: () => void;
	onSend: (text: string) => void;
}) {
	const [reply, setReply] = useState("");
	const left = item.due ? daysUntil(item.due, now) : null;
	const send = () => {
		const text = reply.trim();
		if (!text) return;
		onSend(text);
		setReply("");
	};
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the Today keys (down, up, Enter) pick rows
		<li
			data-today-row={item.key}
			onClick={onSelect}
			className={cn(
				"rounded-xl border border-border bg-card px-3.5 py-3 transition-shadow",
				selected && "ring-2 ring-primary/60",
			)}
		>
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<button
						type="button"
						title="Open this session"
						onClick={onOpen}
						className="max-w-full truncate text-left text-[14px] font-semibold hover:underline"
					>
						{item.starred && <span className="mr-1 text-attention">★</span>}
						{item.title}
					</button>
					{about && (
						<div className="select-text cursor-text text-[12.5px] leading-relaxed text-muted-foreground">
							{about}
						</div>
					)}
					{line && (
						<div className="select-text cursor-text text-[13px] leading-relaxed text-soft-foreground">
							{line}
						</div>
					)}
					{item.waitingOn && (
						<div className="text-[12px] text-muted-foreground">
							Waiting on {item.waitingOn}
						</div>
					)}
				</div>
				{item.due && left !== null && (
					<span
						className={cn(
							MARK,
							left < 0 ? PILL.alarm : left <= 1 ? PILL.attention : PILL.neutral,
						)}
					>
						{dueLabel(item.due, left)}
					</span>
				)}
				{item.urgency === "high" && (
					<span className={cn(MARK, PILL.danger)}>
						{item.priority ?? "High"}
					</span>
				)}
			</div>
			{card.meta && (
				<div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted-foreground">
					{card.meta}
				</div>
			)}
			{item.group === "needs-you" && (
				<TodayActionItems card={card} onSend={onSend} />
			)}
			<div className="mt-2 flex flex-wrap items-center gap-1.5">
				<button
					type="button"
					onClick={onOpen}
					className={cn(BTN, BUTTON.primary)}
				>
					Open
				</button>
				{card.actions}
				<input
					value={reply}
					onChange={(event) => setReply(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.nativeEvent.isComposing) {
							event.preventDefault();
							send();
						}
					}}
					placeholder="Reply to this session - Enter sends"
					aria-label={`Reply to ${item.title}`}
					className="ml-auto h-7 min-w-[180px] flex-1 rounded-[7px] bg-secondary px-2.5 text-[12px] outline-none ring-1 ring-inset ring-border placeholder:text-muted-foreground focus:ring-primary/60"
				/>
			</div>
		</li>
	);
}

/**
 * A Needs you session's open action items from its latest reply, rendered
 * by the chat view's own card: Do it, Approve, the choice buttons and the
 * Run buttons work as they do there.
 */
function TodayActionItems({
	card,
	onSend,
}: {
	card: TodayCard;
	onSend: (text: string) => void;
}) {
	const { data } = electronTrpc.terminal.readClaudeTranscript.useQuery(
		{ sessionId: card.sessionId ?? "" },
		{ enabled: !!card.sessionId, retry: false, staleTime: 60_000 },
	);
	const write = electronTrpc.terminal.write.useMutation();
	const remote = useTabsStore((s) => !!s.panes[card.paneId]?.odinRemote);
	const last =
		data?.messages.findLast((m) => m.role === "assistant")?.text ?? "";
	const { body, actions } = splitActionItems(last);
	if (!actions || noActionItems(actions)) return null;
	const onRun = card.live
		? (command: string) =>
				runSessionCommand({
					paneId: card.paneId,
					workspaceId: card.workspaceId,
					command,
					runInClaude: (c) =>
						runInClaudePrompt(write.mutateAsync, card.paneId, c),
					sendToClaude: onSend,
				})
		: undefined;
	// As the chat view: `!local`, downloads and views only for a session on the host.
	const commands = onRun
		? bangCommands(last).filter(
				(command) =>
					remote ||
					(!localCommand(command) &&
						!downloadPath(command) &&
						!viewTarget(command)),
			)
		: [];
	return (
		<CommandNotes.Provider value={onRun ? bangCommandNotes(last) : {}}>
			<ActionItems
				text={actions}
				body={body}
				paneId={card.paneId}
				commands={commands}
				onRun={onRun}
				onDo={(item, number, approve, answer) =>
					onSend(
						approve
							? `Approved - go ahead with action item ${number}: ${item}`
							: answer !== undefined
								? `Action item ${number} (${item}): ${answer}`
								: `Do action item ${number} for me: ${item}`,
					)
				}
			/>
		</CommandNotes.Provider>
	);
}

/** Your tasks the side column lists, from what Tasks already keeps. */
function useTodaySide() {
	const rows = useAllItems();
	const queue = useTaskMeta((s) => s.queue);
	const waiting = useTaskMeta((s) => s.waiting);
	const reminders = useReminders((s) => s.reminders);
	const panes = useTabsStore((s) => s.panes);
	return useMemo(() => {
		const all = Object.values(panes);
		const sideRows: (SideRow & { paneId: string | null })[] = rows.map(
			(row) => {
				const paneId = livePanesOn(all, row)[0]?.id ?? null;
				return {
					key: row.key,
					title: row.title,
					source: row.source,
					url: row.url,
					due: effectiveDue(row.key, reminders, row.dueDate),
					started: !!paneId,
					paneId,
				};
			},
		);
		const now = Date.now();
		const side = todaySide({
			rows: sideRows,
			queue,
			waiting,
			daysUntil: (day) => daysUntil(day, now),
		});
		const byKey = new Map(rows.map((row) => [row.key, row]));
		const paneOf = new Map(sideRows.map((row) => [row.key, row.paneId]));
		return { ...side, byKey, paneOf };
	}, [rows, queue, waiting, reminders, panes]);
}

/** "Due and up next": due tasks, the top of Up next, and what waits on others. */
function TodaySideColumn({
	side,
	onOpen,
}: {
	side: ReturnType<typeof useTodaySide>;
	onOpen: (paneId: string) => void;
}) {
	const { start, isLaunching } = useStartAllItem();
	const now = Date.now();
	const taskButtons = (
		key: string,
		url: string | null,
		source: string | null,
	) => {
		const paneId = side.paneOf.get(key) ?? null;
		const row = side.byKey.get(key);
		return (
			<div className="mt-1 flex flex-wrap gap-1.5">
				{paneId ? (
					<button
						type="button"
						onClick={() => onOpen(paneId)}
						className={cn(BTN, BUTTON.secondary)}
					>
						Go to session
					</button>
				) : (
					row && (
						<button
							type="button"
							disabled={isLaunching}
							onClick={() => void start(row)}
							className={cn(BTN, BUTTON.primary, "disabled:opacity-50")}
						>
							Start
						</button>
					)
				)}
				{url && (
					<button
						type="button"
						onClick={() => openUrl(url)}
						className={cn(BTN, BUTTON.secondary)}
					>
						Open in {source}
					</button>
				)}
			</div>
		);
	};
	const block = (
		id: string | undefined,
		Icon: ComponentType<{ className?: string }>,
		title: string,
		empty: string,
		children: ReactNode[],
	) => (
		<section id={id} className={SCROLL_MARGIN}>
			<h2 className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold">
				<Icon className="size-3.5 text-muted-foreground" />
				{title} ({children.length})
			</h2>
			{children.length ? (
				<ul className="flex flex-col gap-1.5">{children}</ul>
			) : (
				<div className="text-[12px] text-muted-foreground">{empty}</div>
			)}
		</section>
	);
	return (
		<aside
			aria-label="Due and up next"
			className="flex w-full shrink-0 flex-col gap-4 rounded-xl border border-border bg-card/60 p-3.5 lg:sticky lg:top-[calc(var(--today-head,0px)+8px)] lg:w-[340px]"
		>
			<div className="text-[13.5px] font-semibold">Due and up next</div>
			{block(
				undefined,
				LuCalendarClock,
				"Due",
				"Nothing due this week.",
				side.due.map((row) => (
					<li key={row.key} className="rounded-lg bg-secondary/50 px-2.5 py-2">
						<div className="flex items-start gap-2">
							<span className="min-w-0 flex-1 text-[12.5px] font-medium">
								{row.title}
							</span>
							<span
								className={cn(
									MARK,
									row.daysLeft < 0
										? PILL.alarm
										: row.daysLeft <= 1
											? PILL.attention
											: PILL.neutral,
								)}
							>
								{dueLabel(row.due ?? "", row.daysLeft)}
							</span>
						</div>
						{taskButtons(row.key, row.url, row.source)}
					</li>
				)),
			)}
			{block(
				undefined,
				LuListOrdered,
				"Up next",
				"Nothing lined up that hasn't started.",
				side.upNext.map((row) => (
					<li key={row.key} className="rounded-lg bg-secondary/50 px-2.5 py-2">
						<div className="text-[12.5px] font-medium">{row.title}</div>
						{taskButtons(row.key, row.url, row.source)}
					</li>
				)),
			)}
			{block(
				undefined,
				LuHourglass,
				"Waiting on others",
				"Nothing parked.",
				side.waiting.map((row) => {
					const back = daysUntil(row.until, now);
					return (
						<li
							key={row.key}
							className="rounded-lg bg-secondary/50 px-2.5 py-2"
						>
							<div className="text-[12.5px] font-medium">{row.title}</div>
							<div className="text-[11.5px] text-muted-foreground">
								{row.on ? `Waiting on ${row.on}` : "Waiting"} - back on Up next{" "}
								{back <= 0
									? "today"
									: back === 1
										? "tomorrow"
										: `in ${back} days`}
							</div>
							{taskButtons(row.key, row.url, row.source)}
						</li>
					);
				}),
			)}
		</aside>
	);
}
