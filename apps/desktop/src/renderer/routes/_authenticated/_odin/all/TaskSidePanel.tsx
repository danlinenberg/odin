import { cn } from "@odin/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { openUrl } from "renderer/stores/in-app-browser";
import { useTabsStore } from "renderer/stores/tabs/store";
import { MyTodos } from "../board/SessionBrief";
import { DoneButton } from "../components/DoneButton";
import { DROP_LABEL, SweepDrop } from "../components/DropHint";
import {
	FeedSelect,
	ROW_LINK_BUTTON,
	ROW_LIVE_BUTTON,
	ROW_START_BUTTON,
} from "../components/FeedChrome";
import { guardTaskDone } from "../hooks/done-guard";
import { useDone } from "../hooks/useDone";
import {
	PRIORITY_LABELS,
	priorityOf,
	useOdinTasks,
} from "../hooks/useOdinTasks";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { type AllItem, todoPanesOn } from "./all-items";
import { MetaOptionSelect } from "./MetaOptionSelect";
import { TaskDescription } from "./TaskDescription";
import { TaskDetails } from "./TaskDetails";
import { useTaskRows } from "./TaskTable";
import {
	dayAfter,
	type TaskStatus,
	type TaskType,
	typeOf,
	useTaskMeta,
	WAIT_DAYS,
	type Waiting,
} from "./task-meta";
import { useTitleOverrides } from "./title-overrides";
import { START_ANOTHER_TIP, START_SESSION_TIP } from "./use-start-item";

/**
 * A task in full beside a list: its fields, its text and notes, its
 * sessions' to-dos, and Start or Go to session, Read later, Drop and Done.
 * Tasks shows it beside its list; Today shows it for a task its sessions
 * were started from.
 */
export function TaskSidePanel({
	item,
	onGoTo,
	onClose,
	onOpenFeed,
	onSlackStarted,
	notice,
	top,
}: {
	item: AllItem;
	/** Opens one of the task's sessions. */
	onGoTo: (paneId: string) => void;
	onClose: () => void;
	/** Opens the row's own feed; its feed tab when left out. */
	onOpenFeed?: () => void;
	/** After Start on a Slack row, so the page can re-read its reactions. */
	onSlackStarted?: () => void;
	/** Why the row isn't in the list beside the panel, when it isn't. */
	notice?: ReactNode;
	top?: ReactNode;
}) {
	const navigate = useNavigate();
	const rows = useTaskRows(onSlackStarted);
	const { markDone } = useDone();
	const tasks = useOdinTasks((s) => s.tasks);
	const { setPriority, setNotes } = useOdinTasks.getState();
	const priorityOverrides = useTitleOverrides((s) => s.priorities);
	const setRowPriority = useTitleOverrides((s) => s.setPriority);
	const {
		statuses,
		types,
		notes: rowNotes,
		queue,
		setStatus: setRowStatus,
		setType: setRowType,
		setNote: setRowNote,
		enqueue,
		dequeue,
		waiting: parkedBy,
		wait,
		unwait,
	} = useTaskMeta();
	const task = tasks.find((t) => `task:${t.id}` === item.key);
	// Done from the panel; it closes once the task is Done, not on Cancel.
	const finish = () =>
		guardTaskDone(item, () => {
			markDone(item);
			dequeue(item.key);
			onClose();
		});
	return (
		<DetailsPanel
			item={item}
			onGoTo={onGoTo}
			onClose={onClose}
			onOpenFeed={onOpenFeed ?? (() => navigate({ to: item.to }))}
			notice={notice}
			top={top}
			fields={
				<TaskFields
					status={statuses[item.key] ?? ""}
					type={typeOf(item, types) ?? ""}
					priority={
						task
							? String(priorityOf(task))
							: (priorityOverrides[item.key] ?? "")
					}
					priorityOptions={
						task
							? OWN_PRIORITIES
							: [
									[
										"",
										`${(item.sourcePriority !== undefined ? item.sourcePriority : item.priority) ?? "No priority"} (from ${item.source})`,
									],
									...SOURCE_PRIORITIES,
								]
					}
					queued={queue.includes(item.key)}
					waiting={parkedBy[item.key]}
					person={item.person}
					onWait={(on, until) => wait(item.key, on, until, item.title)}
					onUnwait={() => unwait(item.key, true)}
					onStatus={(value) =>
						setRowStatus(item.key, (value as TaskStatus) || null)
					}
					onType={(value) => setRowType(item.key, (value as TaskType) || null)}
					onPriority={(value) =>
						task
							? setPriority(task.id, Number(value))
							: setRowPriority(item.key, value)
					}
					onQueue={() =>
						queue.includes(item.key) ? dequeue(item.key) : enqueue(item.key)
					}
				/>
			}
			description={
				task && (
					<TaskDescription
						key={task.id}
						notes={task.notes}
						onSave={(notes) => setNotes(task.id, notes)}
					/>
				)
			}
			notes={
				// Slack, Jira and the rest keep their own text as the body;
				// yours goes under it, kept in Odin only.
				!task && (
					<TaskDescription
						key={item.key}
						notes={rowNotes[item.key] ?? ""}
						onSave={(notes) => setRowNote(item.key, notes)}
					/>
				)
			}
		>
			<DetailsActions
				activePaneId={rows.livePaneFor(item)}
				sessionCount={rows.livePanesFor(item).length}
				isLaunching={rows.isLaunching}
				launching={rows.launchingKey === item.launch.key}
				onStart={() => void rows.start(item)}
				onGoTo={onGoTo}
				reading={rows.readingKeys.has(item.key)}
				onReadLater={() =>
					rows.readingKeys.has(item.key)
						? rows.undo(item)
						: rows.markReading(item)
				}
				onDone={finish}
				onDrop={() => {
					rows.drop(item);
					onClose();
				}}
			/>
		</DetailsPanel>
	);
}

/**
 * One row in full, beside the list - so reading a task doesn't cost you your
 * place in it. Its own feed and its upstream page stay one click away.
 */
function DetailsPanel({
	item,
	onGoTo,
	onClose,
	onOpenFeed,
	notice,
	fields,
	description,
	notes,
	top,
	children,
}: {
	item: AllItem;
	/** Opens a session on the board. */
	onGoTo: (paneId: string) => void;
	onClose: () => void;
	onOpenFeed: () => void;
	/** Why the row isn't in the list beside the panel, when it isn't. */
	notice?: ReactNode;
	fields: ReactNode;
	description: ReactNode;
	/** Your notes on another source's row, under its own text. */
	notes?: ReactNode;
	/** Above the fields: what the page showing the panel adds, like Today's action items. */
	top?: ReactNode;
	children: ReactNode;
}) {
	const url = item.url;
	const rename = useTitleOverrides((s) => s.rename);
	return (
		<aside
			data-task-panel
			className="flex w-[380px] shrink-0 flex-col border-l border-border"
		>
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
			{notice && (
				<div className="px-3.5 pb-1.5 text-[11px] text-muted-foreground">
					{notice}
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-[18px]">
				{top}
				{fields}
				<div className="mb-2 empty:hidden">
					<SweepDrop itemKey={item.key} url={item.url} inline={false} />
				</div>
				<TaskDetails item={item} onRename={rename} description={description}>
					{notes && (
						<div>
							<div
								className={PANEL_LABEL}
								title="Kept in Odin only - nothing goes back to the source. Start session adds them to the brief."
							>
								Notes
							</div>
							{notes}
						</div>
					)}
					<SessionTodos item={item} onGoTo={onGoTo} />
				</TaskDetails>
			</div>
			{children}
		</aside>
	);
}

/**
 * The to-dos from My notes on each session linked to this task, ticked and
 * edited in the same store the session drawer uses. With several sessions,
 * each list sits under its session's name.
 */
function SessionTodos({
	item,
	onGoTo,
}: {
	item: AllItem;
	onGoTo: (paneId: string) => void;
}) {
	const panes = useTabsStore((s) => s.panes);
	const todosByPane = usePaneMeta((s) => s.todosByPane);
	const titleByPane = usePaneMeta((s) => s.titleByPane);
	const linked = useMemo(
		() => todoPanesOn(Object.values(panes), item, todosByPane),
		[panes, item, todosByPane],
	);
	if (!linked.length) return null;
	return (
		<div>
			<div
				className={PANEL_LABEL}
				title="From My notes in this task's sessions - ticking one here ticks it there too."
			>
				Session to-dos
			</div>
			<div className="flex flex-col gap-2">
				{linked.map((pane) => (
					<div key={pane.id} className="flex flex-col gap-1">
						{linked.length > 1 && (
							<button
								type="button"
								onClick={() => onGoTo(pane.id)}
								title="Go to this session"
								className="truncate text-left text-[11px] text-muted-foreground hover:text-foreground hover:underline"
							>
								{titleByPane[pane.id] ??
									pane.odinTaskTitle ??
									pane.userTitle ??
									pane.name}{" "}
								→
							</button>
						)}
						<MyTodos paneId={pane.id} onGoToReply={() => onGoTo(pane.id)} />
					</div>
				))}
			</div>
		</div>
	);
}

/** The row's own buttons, so a task read in the panel is acted on there. */
function DetailsActions({
	activePaneId,
	sessionCount,
	isLaunching,
	launching,
	onStart,
	onGoTo,
	reading,
	onReadLater,
	onDone,
	onDrop,
}: {
	activePaneId: string | null;
	/** Sessions open on this task; Go to session opens the newest. */
	sessionCount: number;
	isLaunching: boolean;
	launching: boolean;
	onStart: () => void;
	onGoTo: (paneId: string) => void;
	reading: boolean;
	onReadLater: () => void;
	onDone: () => void;
	onDrop: () => void;
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-t border-border px-3.5 py-2.5">
			{activePaneId ? (
				<>
					<button
						type="button"
						onClick={() => onGoTo(activePaneId)}
						title={
							sessionCount > 1
								? `${sessionCount} sessions on this task - this opens the newest`
								: undefined
						}
						className={ROW_LIVE_BUTTON}
					>
						Go to session →
					</button>
					<button
						type="button"
						disabled={isLaunching}
						onClick={onStart}
						title={START_ANOTHER_TIP}
						className={ROW_LINK_BUTTON}
					>
						{launching ? "Starting…" : "Start another session"}
					</button>
				</>
			) : (
				<button
					type="button"
					disabled={isLaunching}
					onClick={onStart}
					aria-label="Start session"
					title={START_SESSION_TIP}
					className={ROW_START_BUTTON}
				>
					{launching ? "Starting…" : "Start session"}
				</button>
			)}
			<ReadLaterButton on={reading} onClick={onReadLater} />
			<button
				type="button"
				onClick={onDrop}
				title={DROP_LABEL}
				className={cn(ROW_LINK_BUTTON, "hover:text-danger")}
			>
				Drop
			</button>
			<span className="ml-auto">
				<DoneButton onClick={onDone} />
			</span>
		</div>
	);
}

/** Read later, or back from it. Read later moves the row to Docs. */
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
				on ? "Back to Waiting on you" : "Mark it Read later - it moves to Docs"
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

/** The name box "+ Add status..." / "+ Add type..." opens, sized like the pill it replaces. */
const PANEL_INPUT =
	"w-[180px] rounded-full border border-primary bg-card px-2.5 py-1 text-[12px] text-foreground outline-none";

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
	waiting,
	person,
	onWait,
	onUnwait,
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
	waiting: Waiting | undefined;
	person: string | null;
	onWait: (on: string, until: string) => void;
	onUnwait: () => void;
}) {
	return (
		<>
			<div className="mb-2.5 flex flex-wrap items-end gap-1.5">
				<PanelField label="Status">
					<MetaOptionSelect
						kind="status"
						value={status}
						onChange={onStatus}
						empty={<option value="">Waiting on you</option>}
						inputClassName={PANEL_INPUT}
						select={(value, onChange, options) => (
							<FeedSelect value={value} onChange={onChange} title="Status">
								{options}
							</FeedSelect>
						)}
					/>
				</PanelField>
				<PanelField label="Type">
					<MetaOptionSelect
						kind="type"
						value={type}
						onChange={onType}
						empty={<option value="">No type</option>}
						inputClassName={PANEL_INPUT}
						select={(value, onChange, options) => (
							<FeedSelect value={value} onChange={onChange} title="Task type">
								{options}
							</FeedSelect>
						)}
					/>
				</PanelField>
				<PanelField label="Priority">
					<FeedSelect value={priority} onChange={onPriority} title="Priority">
						{priorityOptions.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</FeedSelect>
				</PanelField>
				<button
					type="button"
					onClick={onQueue}
					className={cn(ROW_LINK_BUTTON, queued && "text-foreground")}
				>
					{queued ? "✓ Up next" : "+ Up next"}
				</button>
			</div>
			<WaitField
				waiting={waiting}
				person={person}
				onWait={onWait}
				onUnwait={onUnwait}
			/>
		</>
	);
}

/**
 * Waiting on someone else: who or what, and the day to look again - not the
 * due date. Parking it takes it off Up next; on that day it goes back on top.
 */
function WaitField({
	waiting,
	person,
	onWait,
	onUnwait,
}: {
	waiting: Waiting | undefined;
	person: string | null;
	onWait: (on: string, until: string) => void;
	onUnwait: () => void;
}) {
	const [on, setOn] = useState(waiting?.on ?? "");
	const [until, setUntil] = useState(
		() => waiting?.until ?? dayAfter(Date.now(), WAIT_DAYS),
	);
	// Another row opened in the panel, or the wait changed elsewhere.
	useEffect(() => {
		setOn(waiting?.on ?? "");
		setUntil(waiting?.until ?? dayAfter(Date.now(), WAIT_DAYS));
	}, [waiting]);
	const today = dayAfter(Date.now(), 0);
	// The task's own person first, then everyone in Slack. Free text still
	// goes in: a PR or a date is a fine thing to wait on.
	const { data: slackPeople } = electronTrpc.slack.people.useQuery(undefined, {
		staleTime: 60 * 60_000,
	});
	const people = [
		...new Set([...(person ? [person] : []), ...(slackPeople ?? [])]),
	];
	return (
		<div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[12px]">
			<datalist id="odin-wait-people">
				{people.map((name) => (
					<option key={name} value={name} />
				))}
			</datalist>
			<span className="text-muted-foreground">Waiting on</span>
			<input
				value={on}
				onChange={(e) => setOn(e.target.value)}
				onBlur={() => waiting && on.trim() !== waiting.on && onWait(on, until)}
				placeholder="a teammate, a PR, a date..."
				aria-label="Waiting on"
				list="odin-wait-people"
				className="h-7 min-w-0 flex-1 rounded-[6px] border border-border bg-transparent px-2 text-[12px] text-foreground placeholder:text-muted-foreground"
			/>
			<span className="text-muted-foreground">back on Up next</span>
			<input
				type="date"
				value={until}
				min={dayAfter(Date.now(), 1)}
				onChange={(e) => {
					const day = e.target.value;
					if (!day) return;
					setUntil(day);
					if (waiting && day > today) onWait(on, day);
				}}
				aria-label="Back on Up next on"
				title="The day you expect it to move - not its due date. On that day it goes back on top of Up next."
				style={{ colorScheme: "dark" }}
				className="h-7 rounded-[6px] border border-border bg-transparent px-1.5 text-[12px] text-foreground"
			/>
			{waiting ? (
				<button
					type="button"
					onClick={onUnwait}
					title="Back on top of Up next now"
					className={ROW_LINK_BUTTON}
				>
					Stop waiting
				</button>
			) : (
				<button
					type="button"
					onClick={() =>
						onWait(on, until > today ? until : dayAfter(Date.now(), WAIT_DAYS))
					}
					title="Park it off Up next until that day"
					className={ROW_LINK_BUTTON}
				>
					Wait
				</button>
			)}
		</div>
	);
}

/** The small name over a side panel field. */
const PANEL_LABEL =
	"mb-0.5 select-none text-[10.5px] font-medium text-muted-foreground";

/** A side panel field with its name above it, so the dropdowns tell apart. */
function PanelField({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col">
			<span className={PANEL_LABEL}>{label}</span>
			{children}
		</div>
	);
}
