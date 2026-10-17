import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	MouseSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { openUrl } from "renderer/stores/in-app-browser";
import type { BoardSection } from "shared/board-section";
import type { PaneStatus } from "shared/tabs-types";
import { DoneButton } from "../components/DoneButton";
import { SweepDrop } from "../components/DropHint";
import {
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	FeedSearch,
	FeedSelect,
	ROW_LINK_BUTTON,
	ROW_LIVE_BUTTON,
	ROW_META,
	ROW_PRIMARY_SLOT,
	ROW_START_BUTTON,
	SECTION_HINT,
	SECTION_LABEL,
	SyncButton,
} from "../components/FeedChrome";
import type { FeedPath } from "../components/feed-counts";
import { PersonChip } from "../components/PersonChip";
import { effectiveDue, isDue, useReminders } from "../components/Reminders";
import { TaskBox } from "../components/TaskBox";
import { useActiveSessions } from "../hooks/useActiveSessions";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import {
	PRIORITY_LABELS,
	priorityOf,
	useMyTasks,
	useOdinTasks,
} from "../hooks/useOdinTasks";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import {
	type AllItem,
	type Band,
	bandOf,
	matchesStatus,
	NO_STATUS,
	type Urgency,
} from "./all-items";
import { nextSelection, visibleSelection } from "./selection";
import { TaskDescription } from "./TaskDescription";
import { TaskDetails } from "./TaskDetails";
import {
	SOURCE_ICON,
	type SortableBits,
	SortableRow,
	TABLE_LIST,
	TaskRow,
	TaskTableHeader,
	useTaskRows,
} from "./TaskTable";
import {
	TASK_STATUSES,
	TASK_TYPES,
	type TaskStatus,
	type TaskType,
	typeOf,
	useTaskMeta,
} from "./task-meta";
import { useTitleOverrides } from "./title-overrides";
import { useAllItems, useSearchableItems } from "./use-all-items";

/** `open`: a row key whose details to open - how Search all lands on a row. */
type AllSearch = { open?: string };

export const Route = createFileRoute("/_authenticated/_odin/all/")({
	component: AllFeedPage,
	validateSearch: (search: Record<string, unknown>): AllSearch => ({
		open: typeof search.open === "string" ? search.open : undefined,
	}),
});

/**
 * All - every source in one list, in the order to take it. The per-source
 * tabs are for working a queue; this is for the question they can't answer
 * between them, which is "what do I do now".
 *
 * Rows sit in three bands - Now, Today, Later (all-items.ts: bandOf) - and
 * each says why it is where it is: "asked you 2h ago", "review requested
 * 1d ago". That reason stands in for the High every Slack ask and @-mention
 * used to be painted, which made High mean nothing. Up next, your own order,
 * sits above the bands.
 *
 * Every session running right now folds to one strip above them, whichever
 * tab started it - the per-source feeds each mark only their own rows live,
 * and a Slack row leaves its queue as soon as its session starts, so this is
 * the one place that can answer "what's already going". "show rows" opens it.
 *
 * Rows are filtered from one menu - source, priority, place, status, due,
 * done - and what's applied shows as chips under the header, so the list
 * never narrows without saying so. Rows start a session here too: each
 * feed's prompt builder is shared (feed-prompts.ts, thread-prompt.ts,
 * notion/rows.ts), and the launch payload is built in all-items.ts.
 */

/**
 * A running session's source, in the same terms the rows use - the board's
 * section names on one side, the feed that started it on the other. "normal"
 * is a session started from a prompt rather than a feed row.
 */
const SESSION_SOURCE: Record<
	BoardSection,
	{ to: FeedPath; source: AllItem["source"] }
> = {
	slack: { to: "/reactions", source: "Slack" },
	reactions: { to: "/reactions", source: "Slack" },
	jira: { to: "/jira", source: "Jira" },
	pr: { to: "/prs", source: "GitHub" },
	notion: { to: "/notion", source: "Notion" },
	normal: { to: "/my-tasks", source: "Tasks" },
	// Parked is a state, not a source - a session from any feed can be in it,
	// and the board's own section is where that's visible. Reading it as a task
	// keeps the row honest about the one thing it can say for sure: it isn't a
	// feed item.
	parked: { to: "/my-tasks", source: "Tasks" },
	// Same for these board-only states.
	queued: { to: "/my-tasks", source: "Tasks" },
	recent: { to: "/my-tasks", source: "Tasks" },
	starred: { to: "/my-tasks", source: "Tasks" },
};

/** What a live session is doing - the board's columns, as a chip. */
const SESSION_STATE: Partial<
	Record<PaneStatus, { label: string; dot: string }>
> = {
	permission: { label: "needs you", dot: PANE_STATUS.permission.dot },
	working: { label: "working", dot: PANE_STATUS.working.dot },
	review: { label: "done", dot: PANE_STATUS.review.dot },
	idle: { label: "idle", dot: PANE_STATUS.idle.dot },
};

/** The source filter, in the order the tab strip lists them. */
const SOURCES = [
	"Tasks",
	"Slack",
	"Jira",
	"GitHub",
	"Notion",
	"Email",
	"ClickUp",
] as const;

/** The urgency filter's options - "none" is the rows their source never rated. */
const URGENCIES: { id: Exclude<Urgency, null> | "none"; label: string }[] = [
	{ id: "high", label: "High" },
	{ id: "medium", label: "Medium" },
	{ id: "low", label: "Low" },
	{ id: "none", label: "Unrated" },
];

/** The status filter: Odin's own statuses, plus the two every row always had. */
const STATUS_FILTERS: { id: string; label: string }[] = [
	{ id: "waiting", label: "Waiting on you" },
	...TASK_STATUSES,
	{ id: "reading", label: "Read later" },
];

/** The bands, top to bottom, and what each one says it holds. */
const BANDS: { id: Band; label: string; hint: string }[] = [
	{ id: "now", label: "Now", hint: "due, or asked in the last 4h" },
	{ id: "today", label: "Today", hint: "reviews and asks waiting on you" },
	{ id: "later", label: "Later", hint: "" },
];

const SHOW_SESSIONS_KEY = "odin.all.showSessions";
/** Kept, unlike the other cuts: hiding Backlog is a standing choice, not a
 * look around. "only:<status>" or "hide:<status>"; "" is every status. */
const STATUS_FILTER_KEY = "odin.all.statusFilter";

function readStatusFilter(): string {
	try {
		return localStorage.getItem(STATUS_FILTER_KEY) ?? "";
	} catch {
		return "";
	}
}

function readShowSessions(): boolean {
	try {
		return localStorage.getItem(SHOW_SESSIONS_KEY) === "true";
	} catch {
		return false;
	}
}

function AllFeedPage() {
	const { reactions, syncAll, isSyncing } = useOdinFeeds();
	const navigate = useNavigate();
	const [showSessions, setShowSessions] = useState(readShowSessions);
	const toggleSessions = () => {
		const next = !showSessions;
		setShowSessions(next);
		try {
			localStorage.setItem(SHOW_SESSIONS_KEY, String(next));
		} catch {}
	};
	// The ways to cut the list. Local state: All is the "what now" view, and it
	// should open saying everything, every time.
	const [source, setSource] = useState<AllItem["source"] | "">("");
	const [urgency, setUrgency] = useState("");
	const [context, setContext] = useState("");
	const [statusFilter, setStatusFilterState] = useState(readStatusFilter);
	const setStatusFilter = (value: string) => {
		setStatusFilterState(value);
		try {
			localStorage.setItem(STATUS_FILTER_KEY, value);
		} catch {}
	};
	const [dueOnly, setDueOnly] = useState(false);
	// Free text, matched against everything a row shows - title, who, where,
	// status - so "terraform" or a colleague's name finds it without a picker.
	const [search, setSearch] = useState("");
	// Order inside a band. "updated" is the feeds' own order (allItems);
	// "created" is when each row landed on your list - for Slack, the :eyes:.
	const [sortBy, setSortBy] = useState<"updated" | "created">("updated");
	const needle = search.trim().toLowerCase();
	const reminders = useReminders((s) => s.reminders);
	const rows = useTaskRows(() => void reactions.refetch());
	const { start: handleStart, livePaneFor, isLaunching, launchingKey } = rows;
	const sessions = useActiveSessions();
	const needsYou = sessions.filter(
		(session) => session.column === "permission",
	);
	const goToPane = (paneId: string) => {
		usePendingFocus.getState().focus(paneId);
		navigate({ to: "/board" });
	};

	// Done rows - from any feed, Next in line, or a Review drop - aren't
	// waiting on you. They're one click away under Done, with Undo.
	// Reading material is the same put-away, for rows with nothing left to do
	// but worth keeping: off every queue and the Night Agent, listed in Later.
	const {
		markDone,
		markReading,
		undo,
		recent,
		reading,
		set: setDone,
	} = useDone();
	const [shelf, setShelf] = useState(false);
	// Undo on the last row hides its chip too: back to the queue, not a blank.
	const showDone = shelf && recent.length > 0;
	const readingKeys = useMemo(
		() => new Set(reading.map((row) => row.key)),
		[reading],
	);
	const {
		statuses,
		types,
		queue,
		setStatus: setRowStatus,
		setType: setRowType,
		enqueue,
		dequeue,
		move,
	} = useTaskMeta();
	const statusOf = useCallback(
		(item: AllItem): string =>
			readingKeys.has(item.key) ? "reading" : (statuses[item.key] ?? "waiting"),
		[readingKeys, statuses],
	);
	// The compose box, same as Mine's - a task written here lands on this list.
	const { add } = useMyTasks();
	const tasks = useOdinTasks((s) => s.tasks);
	const { setPriority, setNotes } = useOdinTasks.getState();
	// Slack, Jira and the rest: your level over the source's, kept in Odin.
	const priorityOverrides = useTitleOverrides((s) => s.priorities);
	const setRowPriority = useTitleOverrides((s) => s.setPriority);
	const [draft, setDraft] = useState("");
	const [draftRepo, setDraftRepo] = useState("");
	const { data: skills } = electronTrpc.skills.list.useQuery();
	const { data: docs } = electronTrpc.system.listDocs.useQuery();
	const { data: repos } = electronTrpc.repos.list.useQuery();
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
	);
	// The row whose details sit in the side panel. A title click opens it here
	// rather than jumping to the row's own feed tab, which dropped you out of
	// this list and left you hunting for the row again.
	const [openKey, setOpenKey] = useState<string | null>(null);
	// Taken off the URL once read, so picking the same row again reopens it.
	const { open } = Route.useSearch();
	useEffect(() => {
		if (!open) return;
		setOpenKey(open);
		void navigate({ to: "/all", search: {}, replace: true });
	}, [open, navigate]);
	const allRows = useAllItems();
	const everyRow = useSearchableItems();

	const sourceCounts = useMemo(() => {
		const counts = new Map<AllItem["source"], number>();
		for (const item of allRows)
			counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
		return counts;
	}, [allRows]);

	const bySource = useMemo(
		() => (source ? allRows.filter((item) => item.source === source) : allRows),
		[allRows, source],
	);

	// Both pickers count what picking them would leave, against the filters
	// above them - urgency within the chosen source, place within both.
	const urgencyCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const item of bySource) {
			const id = item.urgency ?? "none";
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
		return counts;
	}, [bySource]);

	const byUrgency = useMemo(
		() =>
			urgency
				? bySource.filter((item) => (item.urgency ?? "none") === urgency)
				: bySource,
		[bySource, urgency],
	);

	/** Channels, repos, projects - whatever the remaining rows call home. */
	const places = useMemo(() => {
		const counts = new Map<string, number>();
		for (const item of byUrgency)
			if (item.context)
				counts.set(item.context, (counts.get(item.context) ?? 0) + 1);
		return [...counts.entries()].sort(
			(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
		);
	}, [byUrgency]);

	const byContext = useMemo(
		() =>
			context
				? byUrgency.filter((item) => item.context === context)
				: byUrgency,
		[byUrgency, context],
	);

	/** Every status the remaining rows carry, Jira's and Notion's own words. */
	const upstreamStatuses = useMemo(() => {
		const counts = new Map<string, number>();
		for (const item of byContext) {
			const status = item.status ?? NO_STATUS;
			counts.set(status, (counts.get(status) ?? 0) + 1);
		}
		return [...counts.entries()].sort(
			(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
		);
	}, [byContext]);

	// One picker for both: "odin:<id>" is Odin's own status, "only:"/"hide:"
	// the source's.
	const byStatus = useMemo(
		() =>
			byContext.filter((item) =>
				statusFilter.startsWith("odin:")
					? statusOf(item) === statusFilter.slice(5)
					: matchesStatus(item, statusFilter),
			),
		[byContext, statusFilter, statusOf],
	);

	// Counted over everything on screen rather than the current cut: a ticket
	// that went overdue under a filter you aren't looking through still has to
	// be findable from here.
	const dueRows = useMemo(
		() =>
			allRows.filter((item) =>
				isDue(effectiveDue(item.key, reminders, item.dueDate), Date.now()),
			),
		[allRows, reminders],
	);
	const statusCounts = new Map<string, number>();
	for (const item of byContext)
		statusCounts.set(
			statusOf(item),
			(statusCounts.get(statusOf(item)) ?? 0) + 1,
		);
	// Up next sits above the bands in your order, so it isn't listed twice.
	const queued = queue.flatMap((key) => {
		const item = allRows.find((row) => row.key === key);
		return item ? [item] : [];
	});
	// A finished row leaves Up next too, so an Undo doesn't bring it back there.
	const finish = (item: AllItem) => {
		markDone(item);
		dequeue(item.key);
	};
	const onDragEnd = ({ active, over }: DragEndEvent) => {
		if (over) move(String(active.id), String(over.id));
	};
	const items = useMemo(() => {
		const listed = byStatus.filter((item) => !queue.includes(item.key));
		const due = dueOnly
			? listed.filter((item) =>
					isDue(effectiveDue(item.key, reminders, item.dueDate), Date.now()),
				)
			: listed;
		const sorted =
			sortBy === "created"
				? [...due].sort((a, b) => b.createdAt - a.createdAt)
				: due;
		if (!needle) return sorted;
		return sorted.filter((item) =>
			[
				item.title,
				item.person,
				item.context,
				item.status,
				item.source,
				item.mention?.text,
			]
				.join(" ")
				.toLowerCase()
				.includes(needle),
		);
	}, [byStatus, dueOnly, reminders, needle, sortBy, queue]);

	// The bands. One clock per render: a row's reason and its band must agree.
	const now = Date.now();
	const bands = useMemo(() => {
		const out: Record<Band, AllItem[]> = { now: [], today: [], later: [] };
		for (const item of items)
			out[
				bandOf(
					item,
					isDue(effectiveDue(item.key, reminders, item.dueDate), now),
					now,
					readingKeys.has(item.key),
				)
			].push(item);
		return out;
	}, [items, reminders, readingKeys, now]);

	// Ticked rows, for acting on many at once. Only rows still on screen count:
	// a filter or a Done that hides a ticked row takes it out of the next action.
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [anchor, setAnchor] = useState<string | null>(null);
	const visibleKeys = items.map((item) => item.key);
	const picked = visibleSelection(selected, visibleKeys);
	const tick = (key: string, shift: boolean) => {
		setSelected(nextSelection(selected, visibleKeys, key, shift, anchor));
		setAnchor(key);
	};
	const clearPicked = () => setSelected(new Set());
	// One toast for the lot, and one Undo that brings every row back.
	const finishPicked = () => {
		const rows = items.filter((item) => selected.has(item.key));
		for (const item of rows) {
			setDone(item, true);
			dequeue(item.key);
		}
		toast.success(
			`Done - ${rows.length} ${rows.length === 1 ? "task" : "tasks"}`,
			{
				action: {
					label: "Undo",
					onClick: () => {
						for (const item of rows) setDone(item, false);
					},
				},
			},
		);
		clearPicked();
	};

	// From every row, not the filtered ones: narrowing the list shouldn't shut
	// the panel you're reading. Marking it done does. Search all can open a row
	// All leaves out (Done'd, started, your own PR), hence the wider fallback.
	const openItem =
		allRows.find((item) => item.key === openKey) ??
		everyRow.find((item) => item.key === openKey);
	const openTask = tasks.find((task) => `task:${task.id}` === openItem?.key);

	const statusFilterLabel = statusFilter.startsWith("odin:")
		? STATUS_FILTERS.find(({ id }) => id === statusFilter.slice(5))?.label
		: statusFilter.startsWith("hide:")
			? `Hide ${statusFilter.slice(5)}`
			: statusFilter.slice(5);
	/** What's applied, as the chips under the header say it. */
	const applied: { label: string; clear: () => void }[] = [
		...(source ? [{ label: source, clear: () => setSource("") }] : []),
		...(urgency
			? [
					{
						label: URGENCIES.find(({ id }) => id === urgency)?.label ?? urgency,
						clear: () => setUrgency(""),
					},
				]
			: []),
		...(context ? [{ label: context, clear: () => setContext("") }] : []),
		...(statusFilter
			? [
					{
						label: statusFilterLabel ?? statusFilter,
						clear: () => setStatusFilter(""),
					},
				]
			: []),
		...(dueOnly ? [{ label: "Due", clear: () => setDueOnly(false) }] : []),
		...(showDone ? [{ label: "Done", clear: () => setShelf(false) }] : []),
	];
	const isFiltered = applied.length > 0 || !!needle;
	const clearFilters = () => {
		setSource("");
		setUrgency("");
		setContext("");
		setStatusFilter("");
		setDueOnly(false);
		setShelf(false);
		setSearch("");
	};

	// Backlog, Read later and the rest are on the list but not waiting on you.
	const waiting = statusCounts.get("waiting") ?? 0;
	const shown = items.length + queued.length;

	/** One row of the list. */
	const renderRow = (
		item: AllItem,
		drag?: SortableBits & { place: number },
	) => (
		<TaskRow
			key={item.key}
			item={item}
			rows={rows}
			now={now}
			created={sortBy === "created"}
			drag={drag}
			select={{
				checked: selected.has(item.key),
				onTick: (shift) => tick(item.key, shift),
			}}
			open={item.key === openKey}
			onOpen={() => setOpenKey(item.key === openKey ? null : item.key)}
		/>
	);

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<span className="shrink-0 text-[12px] text-muted-foreground">
					{shown !== allRows.length ? `${shown} of ${allRows.length} · ` : ""}
					{waiting} waiting on you
					{(bands.now.length > 0 || bands.today.length > 0) &&
						` · ${bands.now.length} now · ${bands.today.length} today`}
				</span>
				<div className="ml-auto flex items-center gap-2.5">
					<FeedSearch value={search} onChange={setSearch} />
					<FilterMenu active={applied.length}>
						<Facet label="Source">
							<FeedSelect
								value={source}
								onChange={(value) => {
									setSource(value as AllItem["source"] | "");
									setContext("");
								}}
								title="Filter by source"
							>
								<option value="">Any source</option>
								{SOURCES.filter(
									// A source with nothing in it (Notion not connected, no
									// PRs) is an option that can only empty the list.
									(name) =>
										(sourceCounts.get(name) ?? 0) > 0 || source === name,
								).map((name) => (
									<option key={name} value={name}>
										{name} ({sourceCounts.get(name) ?? 0})
									</option>
								))}
							</FeedSelect>
						</Facet>
						<Facet label="Priority">
							<FeedSelect
								value={urgency}
								onChange={setUrgency}
								title="Filter by priority - every source's own words, in three levels"
							>
								<option value="">Any priority</option>
								{URGENCIES.map(({ id, label }) => (
									<option key={id} value={id}>
										{label} ({urgencyCounts.get(id) ?? 0})
									</option>
								))}
							</FeedSelect>
						</Facet>
						<Facet label="Place">
							<FeedSelect
								value={context}
								onChange={setContext}
								title="Filter by channel, repo or project"
							>
								<option value="">Everywhere</option>
								{places.map(([place, count]) => (
									<option key={place} value={place}>
										{place} ({count})
									</option>
								))}
							</FeedSelect>
						</Facet>
						<Facet label="Status">
							<FeedSelect
								value={statusFilter}
								onChange={setStatusFilter}
								title="Filter by status - Odin's own, or the source's: show only one, or hide one (kept until cleared)"
							>
								<option value="">Any status</option>
								<optgroup label="Odin">
									{STATUS_FILTERS.map(({ id, label }) => (
										<option key={id} value={`odin:${id}`}>
											{label} ({statusCounts.get(id) ?? 0})
										</option>
									))}
								</optgroup>
								{/* The kept choice may name a status nothing has right now. */}
								{statusFilter &&
									!statusFilter.startsWith("odin:") &&
									!upstreamStatuses.some(
										([s]) => s === statusFilter.slice(5),
									) && (
										<option value={statusFilter}>
											{statusFilter.startsWith("hide:") ? "Hide " : ""}
											{statusFilter.slice(5)} (0)
										</option>
									)}
								{upstreamStatuses.length > 1 && (
									<>
										<optgroup label="Show only">
											{upstreamStatuses.map(([status, count]) => (
												<option key={status} value={`only:${status}`}>
													{status} ({count})
												</option>
											))}
										</optgroup>
										<optgroup label="Hide">
											{upstreamStatuses.map(([status, count]) => (
												<option key={status} value={`hide:${status}`}>
													Hide {status} ({count})
												</option>
											))}
										</optgroup>
									</>
								)}
							</FeedSelect>
						</Facet>
						{dueRows.length > 0 && (
							<Toggle
								checked={dueOnly}
								onChange={setDueOnly}
								label={`Due or overdue only (${dueRows.length})`}
							/>
						)}
						{recent.length > 0 && (
							<Toggle
								checked={showDone}
								onChange={setShelf}
								label={`Show what's Done (${recent.length})`}
							/>
						)}
					</FilterMenu>
					<FeedSelect
						value={sortBy}
						onChange={(value) => setSortBy(value as "updated" | "created")}
						title="Order inside each band - Created is when a row landed on your list (Slack: when you reacted)"
					>
						<option value="updated">Newest activity</option>
						<option value="created">Created at</option>
					</FeedSelect>
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>
			{applied.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5 border-b border-border px-[18px] py-1.5 text-[11px]">
					{applied.map(({ label, clear }) => (
						<button
							key={label}
							type="button"
							onClick={clear}
							title="Remove this filter"
							className="rounded-full border border-primary/40 bg-primary/15 px-2 py-[1px] font-medium text-primary-ink hover:bg-primary/25"
						>
							{label} ✕
						</button>
					))}
					<button
						type="button"
						onClick={clearFilters}
						className="ml-1 text-muted-foreground transition-colors hover:text-foreground"
					>
						clear all
					</button>
				</div>
			)}

			<div className="border-b border-border px-[18px] py-2">
				<TaskBox
					compact
					value={draft}
					skills={skills}
					docs={docs}
					repos={repos}
					repo={draftRepo}
					onRepoChange={setDraftRepo}
					placeholder="What needs doing?"
					onChange={setDraft}
					onSubmit={() => {
						add(draft, undefined, draftRepo);
						setDraft("");
						setDraftRepo("");
					}}
					onCancel={() => setDraft("")}
					submitLabel="Add task"
				/>
			</div>

			<div className="flex min-h-0 flex-1">
				<div className={TABLE_LIST}>
					{!showDone && sessions.length > 0 && (
						<>
							<div className={SECTION_LABEL}>
								<span className="size-1.5 animate-pulse rounded-full bg-working" />
								Live
								<Count n={sessions.length} />
								{needsYou.length > 0 && (
									<span className={SECTION_HINT}>
										{needsYou.length} need you
									</span>
								)}
								<button
									type="button"
									onClick={toggleSessions}
									className={cn(SECTION_HINT, "hover:text-foreground")}
								>
									{showSessions ? "fold" : "show rows"}
								</button>
							</div>
							{showSessions ? (
								sessions.map((session) => {
									const { to } = SESSION_SOURCE[session.source];
									const SourceIcon = SOURCE_ICON[to];
									const state = SESSION_STATE[session.column];
									return (
										<div
											key={session.paneId}
											className={cn(
												FEED_ROW,
												"mb-1 border-l-2 border-l-working",
											)}
										>
											<div className="flex items-center gap-3">
												<SourceIcon
													className="size-3.5 shrink-0 text-muted-foreground"
													aria-hidden
												/>
												<button
													type="button"
													title="Open the session on the board"
													onClick={() => goToPane(session.paneId)}
													className="min-w-0 flex-1 truncate bg-none text-left text-[13px] font-semibold text-foreground"
												>
													{emojify(session.title)}
												</button>
												{!openItem && (
													<div className="flex shrink-0 items-center gap-2.5 text-[11px]">
														{session.tags[0] && (
															<span className="font-mono text-[10.5px] text-faint-foreground">
																#{session.tags[0]}
															</span>
														)}
														{session.contact && (
															<PersonChip
																name={session.contact}
																className="max-w-[160px]"
															/>
														)}
														{state && (
															<span
																className={cn(
																	ROW_META,
																	"flex items-center gap-1.5",
																)}
															>
																<span
																	className="size-1.5 rounded-full"
																	style={{ backgroundColor: state.dot }}
																/>
																{state.label}
															</span>
														)}
														{session.repo && (
															<span
																className="max-w-[132px] truncate text-muted-foreground"
																title={session.repo}
															>
																{session.repo}
															</span>
														)}
													</div>
												)}
												<span className={ROW_PRIMARY_SLOT}>
													<button
														type="button"
														onClick={() => goToPane(session.paneId)}
														className={ROW_LIVE_BUTTON}
													>
														Go to session →
													</button>
												</span>
											</div>
										</div>
									);
								})
							) : (
								<div
									className={cn(
										FEED_ROW,
										"mb-1 flex items-center gap-3 py-1.5",
									)}
								>
									<div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
										{needsYou.length === 0 && (
											<span className={ROW_META}>all working</span>
										)}
										{needsYou.map((session) => (
											<button
												key={session.paneId}
												type="button"
												title="Open the session on the board"
												onClick={() => goToPane(session.paneId)}
												className="max-w-[220px] shrink-0 truncate rounded-full bg-secondary px-2 py-[1px] text-[11px] text-soft-foreground ring-1 ring-inset ring-attention/50 transition-colors hover:text-foreground"
											>
												{emojify(session.title)}
											</button>
										))}
									</div>
									<button
										type="button"
										onClick={() => navigate({ to: "/board" })}
										className={ROW_LIVE_BUTTON}
									>
										Board →
									</button>
								</div>
							)}
						</>
					)}
					{!showDone && items.length + queued.length > 0 && (
						<TaskTableHeader
							date={sortBy === "created" ? "Created" : "Updated"}
						/>
					)}
					{!showDone && picked.length > 0 && (
						<div className="sticky top-0 z-10 mb-1 flex items-center gap-2 rounded-md border border-primary/40 bg-secondary px-3 py-1.5 text-[12px]">
							<span className="font-semibold text-foreground">
								{picked.length} selected
							</span>
							{picked.length < visibleKeys.length && (
								<button
									type="button"
									onClick={() => setSelected(new Set(visibleKeys))}
									className={ROW_LINK_BUTTON}
								>
									Select all {visibleKeys.length}
								</button>
							)}
							<span className="flex-1" />
							<FeedSelect
								value=""
								onChange={(value) => {
									for (const key of picked)
										setRowStatus(
											key,
											value === "waiting" ? null : (value as TaskStatus),
										);
								}}
								title="Set the status of every selected row"
							>
								<option value="" disabled>
									Set status
								</option>
								<option value="waiting">Waiting on you</option>
								{TASK_STATUSES.map(({ id, label }) => (
									<option key={id} value={id}>
										{label}
									</option>
								))}
							</FeedSelect>
							<button
								type="button"
								onClick={() => {
									for (const key of picked) enqueue(key);
									clearPicked();
								}}
								title="Line them all up - Up next, above the list"
								className={ROW_LINK_BUTTON}
							>
								Up next
							</button>
							<DoneButton onClick={finishPicked} />
							<button
								type="button"
								onClick={clearPicked}
								className={ROW_LINK_BUTTON}
							>
								Clear
							</button>
						</div>
					)}
					{!showDone && queued.length > 0 && (
						<>
							<div className={SECTION_LABEL}>
								Up next
								<Count n={queued.length} />
								<span className={SECTION_HINT}>
									drag to reorder, 1 goes first
								</span>
							</div>
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								onDragEnd={onDragEnd}
							>
								<SortableContext
									items={queued.map((item) => item.key)}
									strategy={verticalListSortingStrategy}
								>
									{queued.map((item, index) => (
										<SortableRow key={item.key} id={item.key}>
											{(bits) => renderRow(item, { ...bits, place: index + 1 })}
										</SortableRow>
									))}
								</SortableContext>
							</DndContext>
						</>
					)}
					{showDone && (
						<DoneList
							rows={recent}
							verb="done"
							onOpen={(url) => openUrl(url)}
							onUndo={undo}
						/>
					)}
					{!showDone && items.length === 0 && (
						<div className="px-2 py-8 text-center text-xs text-muted-foreground">
							{isFiltered ? (
								<button
									type="button"
									onClick={clearFilters}
									className="underline-offset-2 hover:underline"
								>
									Nothing matches these filters - clear them
								</button>
							) : (
								"Nothing waiting on you 🎉"
							)}
						</div>
					)}
					{!showDone &&
						BANDS.map(({ id, label, hint }) =>
							bands[id].length === 0 ? null : (
								<div key={id} className="contents">
									<div className={SECTION_LABEL}>
										{label}
										<Count n={bands[id].length} />
										{hint && <span className={SECTION_HINT}>{hint}</span>}
									</div>
									{bands[id].map((item) => renderRow(item))}
								</div>
							),
						)}
				</div>
				{openItem && (
					<DetailsPanel
						item={openItem}
						onClose={() => setOpenKey(null)}
						onOpenFeed={() => navigate({ to: openItem.to })}
						fields={
							<TaskFields
								status={statuses[openItem.key] ?? ""}
								type={typeOf(openItem, types) ?? ""}
								priority={
									openTask
										? String(priorityOf(openTask))
										: (priorityOverrides[openItem.key] ?? "")
								}
								priorityOptions={
									openTask
										? OWN_PRIORITIES
										: [
												[
													"",
													`${(openItem.sourcePriority !== undefined ? openItem.sourcePriority : openItem.priority) ?? "No priority"} (from ${openItem.source})`,
												],
												...SOURCE_PRIORITIES,
											]
								}
								queued={queue.includes(openItem.key)}
								onStatus={(value) =>
									setRowStatus(openItem.key, (value as TaskStatus) || null)
								}
								onType={(value) =>
									setRowType(openItem.key, (value as TaskType) || null)
								}
								onPriority={(value) =>
									openTask
										? setPriority(openTask.id, Number(value))
										: setRowPriority(openItem.key, value)
								}
								onQueue={() =>
									queue.includes(openItem.key)
										? dequeue(openItem.key)
										: enqueue(openItem.key)
								}
							/>
						}
						description={
							openTask && (
								<TaskDescription
									key={openTask.id}
									notes={openTask.notes}
									onSave={(notes) => setNotes(openTask.id, notes)}
								/>
							)
						}
					>
						<DetailsActions
							activePaneId={livePaneFor(openItem)}
							isLaunching={isLaunching}
							launching={launchingKey === openItem.launch.key}
							onStart={() => void handleStart(openItem)}
							onGoTo={goToPane}
							reading={readingKeys.has(openItem.key)}
							onReadLater={() =>
								readingKeys.has(openItem.key)
									? undo(openItem)
									: markReading(openItem)
							}
							onDone={() => {
								finish(openItem);
								setOpenKey(null);
							}}
						/>
					</DetailsPanel>
				)}
			</div>
		</div>
	);
}

/** A count beside a section label. */
function Count({ n }: { n: number }) {
	return (
		<span className="rounded-[10px] bg-secondary px-1.5 font-medium text-muted-foreground tabular-nums">
			{n}
		</span>
	);
}

/**
 * The one Filter button, and the menu under it. Five pickers on the header
 * row all read "Any …" whether or not one was set; one button that says
 * "Filter · 2" and a row of chips under the header can't hide what's on.
 */
function FilterMenu({
	active,
	children,
}: {
	active: number;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative shrink-0">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className={cn(
					"cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium outline-none",
					active
						? "border-primary bg-primary/15 text-foreground"
						: "border-border bg-card text-muted-foreground hover:text-foreground",
				)}
			>
				{active ? `Filter · ${active}` : "Filter"} ▾
			</button>
			{open && (
				<>
					<button
						type="button"
						aria-label="Close filters"
						onClick={() => setOpen(false)}
						className="fixed inset-0 z-10 cursor-default bg-transparent"
					/>
					<div className="absolute top-full right-0 z-20 mt-1.5 grid w-[520px] grid-cols-2 gap-x-4 gap-y-2.5 rounded-[10px] border border-border bg-popover p-3.5 shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
						{children}
					</div>
				</>
			)}
		</div>
	);
}

/** One labelled picker in the Filter menu. */
function Facet({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid gap-1 text-[11px] font-medium text-muted-foreground [&>select]:max-w-none">
			<span>{label}</span>
			{children}
		</div>
	);
}

/** One on/off cut in the Filter menu. */
function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
}) {
	return (
		<label className="flex cursor-pointer items-center gap-2 text-[12px] text-soft-foreground">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				className="accent-primary"
			/>
			{label}
		</label>
	);
}

/**
 * One row in full, beside the list - so reading a task doesn't cost you your
 * place in it. Its own feed and its upstream page stay one click away.
 */
function DetailsPanel({
	item,
	onClose,
	onOpenFeed,
	fields,
	description,
	children,
}: {
	item: AllItem;
	onClose: () => void;
	onOpenFeed: () => void;
	fields: ReactNode;
	description: ReactNode;
	children: ReactNode;
}) {
	const url = item.url;
	const rename = useTitleOverrides((s) => s.rename);
	return (
		<aside className="flex w-[380px] shrink-0 flex-col border-l border-border">
			<div className="flex shrink-0 items-center gap-2 px-3.5 pt-2 pb-1.5">
				<button
					type="button"
					onClick={onOpenFeed}
					className="text-[12px] font-semibold text-muted-foreground hover:text-foreground"
				>
					{item.source} feed →
				</button>
				{url && (
					<button
						type="button"
						title={url}
						onClick={() => openUrl(url)}
						className="text-[12px] font-semibold text-muted-foreground hover:text-foreground"
					>
						Open ↗
					</button>
				)}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close details"
					className="ml-auto rounded-[7px] px-2 py-0.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground"
				>
					✕
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-[18px]">
				{fields}
				<div className="mb-2 empty:hidden">
					<SweepDrop itemKey={item.key} url={item.url} inline={false} />
				</div>
				<TaskDetails item={item} onRename={rename} description={description} />
			</div>
			{children}
		</aside>
	);
}

/** The row's own buttons, so a task read in the panel is acted on there. */
function DetailsActions({
	activePaneId,
	isLaunching,
	launching,
	onStart,
	onGoTo,
	reading,
	onReadLater,
	onDone,
}: {
	activePaneId: string | null;
	isLaunching: boolean;
	launching: boolean;
	onStart: () => void;
	onGoTo: (paneId: string) => void;
	reading: boolean;
	onReadLater: () => void;
	onDone: () => void;
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-t border-border px-3.5 py-2.5">
			{activePaneId ? (
				<button
					type="button"
					onClick={() => onGoTo(activePaneId)}
					className={ROW_LIVE_BUTTON}
				>
					Go to session →
				</button>
			) : (
				<button
					type="button"
					disabled={isLaunching}
					onClick={onStart}
					className={ROW_START_BUTTON}
				>
					{launching ? "Starting…" : "Start session"}
				</button>
			)}
			<ReadLaterButton on={reading} onClick={onReadLater} />
			<span className="ml-auto">
				<DoneButton onClick={onDone} />
			</span>
		</div>
	);
}

/** Read later, or back from it - the row stays on the list either way. */
function ReadLaterButton({
	on,
	onClick,
}: {
	on: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={
				on
					? "Back to Waiting on you"
					: "Mark it Read later - it stays here, off the Night Agent"
			}
			className={ROW_LINK_BUTTON}
		>
			{on ? "↺ Read later" : "Read later"}
		</button>
	);
}

const OWN_PRIORITIES: [string, string][] = [3, 2, 1].map((level) => [
	String(level),
	PRIORITY_LABELS[level],
]);
/** Another source's row: your level, kept in Odin - nothing goes upstream. */
const SOURCE_PRIORITIES: [string, string][] = ["High", "Medium", "Low"].map(
	(label) => [label, label],
);

/**
 * Status, type, priority and Up next for any row. Priority on another
 * source's row is yours only - Jira and Slack keep their own.
 */
function TaskFields({
	status,
	type,
	priority,
	priorityOptions,
	queued,
	onStatus,
	onType,
	onPriority,
	onQueue,
}: {
	status: string;
	type: string;
	priority: string;
	priorityOptions: [string, string][];
	queued: boolean;
	onStatus: (value: string) => void;
	onType: (value: string) => void;
	onPriority: (value: string) => void;
	onQueue: () => void;
}) {
	return (
		<div className="mb-2.5 flex flex-wrap items-center gap-1.5">
			<FeedSelect value={status} onChange={onStatus} title="Status">
				<option value="">Waiting on you</option>
				{TASK_STATUSES.map(({ id, label }) => (
					<option key={id} value={id}>
						{label}
					</option>
				))}
			</FeedSelect>
			<FeedSelect value={type} onChange={onType} title="Task type">
				<option value="">No type</option>
				{TASK_TYPES.map(({ id, label }) => (
					<option key={id} value={id}>
						{label}
					</option>
				))}
			</FeedSelect>
			<FeedSelect value={priority} onChange={onPriority} title="Priority">
				{priorityOptions.map(([value, label]) => (
					<option key={value} value={value}>
						{label}
					</option>
				))}
			</FeedSelect>
			<button
				type="button"
				onClick={onQueue}
				className={cn(ROW_LINK_BUTTON, queued && "text-foreground")}
			>
				{queued ? "✓ Up next" : "+ Up next"}
			</button>
		</div>
	);
}

/** What was put away lately, newest first, as it looked then - with the way back. */
function DoneList({
	rows,
	verb,
	onOpen,
	onUndo,
}: {
	rows: ReturnType<typeof useDone>["recent"];
	verb: string;
	onOpen: (url: string) => void;
	onUndo: (row: ReturnType<typeof useDone>["recent"][number]) => void;
}) {
	return (
		<>
			{rows.map((row) => (
				<div key={row.key} className={FEED_ROW}>
					<div className="flex items-center gap-3">
						<span className="w-[68px] shrink-0 truncate text-[11px] font-semibold text-muted-foreground">
							{row.source}
						</span>
						<span
							dir="auto"
							className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground"
						>
							{emojify(row.title)}
						</span>
						<span className="shrink-0 text-[11px] text-muted-foreground">
							{verb}{" "}
							{new Date(row.at).toLocaleDateString(undefined, {
								month: "short",
								day: "numeric",
							})}
						</span>
						{row.url && /^https?:\/\//.test(row.url) && (
							<button
								type="button"
								onClick={() => row.url && onOpen(row.url)}
								className="shrink-0 text-[12px] font-semibold text-muted-foreground hover:text-foreground"
							>
								Open ↗
							</button>
						)}
						<button
							type="button"
							onClick={() => onUndo(row)}
							title="Put it back in the queue"
							className="shrink-0 rounded-[7px] px-2 py-1 text-[12px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
						>
							Undo
						</button>
					</div>
				</div>
			))}
		</>
	);
}
