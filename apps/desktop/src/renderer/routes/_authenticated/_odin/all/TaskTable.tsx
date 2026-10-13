import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@odin/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import type { IconType } from "react-icons";
import {
	LuBookmark,
	LuExternalLink,
	LuListMinus,
	LuListPlus,
} from "react-icons/lu";
import { emojify } from "renderer/lib/emoji";
import { openUrl } from "renderer/stores/in-app-browser";
import { DoneButton } from "../components/DoneButton";
import { SweepDrop } from "../components/DropHint";
import {
	FEED_LIST,
	IconTip,
	ROW_ICON_BUTTON,
	ROW_LIVE_BUTTON,
	ROW_META,
	ROW_START_BUTTON,
} from "../components/FeedChrome";
import { FEED_TABS, type FeedPath } from "../components/feed-counts";
import { PersonChip } from "../components/PersonChip";
import { PILL } from "../components/pill";
import {
	DueChip,
	effectiveDue,
	isDue,
	OverdueMark,
	useReminders,
} from "../components/Reminders";
import { TonightButton } from "../components/TonightButton";
import { useDone } from "../hooks/useDone";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { type AllItem, bandOf, plainText, reasonOf } from "./all-items";
import { statusLabel, typeLabel, typeOf, useTaskMeta } from "./task-meta";
import { useStartAllItem } from "./use-start-item";

/**
 * The one task table. All and every feed tab - Tasks, Slack, Jira, GitHub,
 * Notion, Email, ClickUp - draw their rows with TaskRow under TaskTableHeader,
 * so a task looks the same, sits in the same columns and has the same actions
 * wherever it shows. The feeds keep their own filters and grouping; the row is
 * not theirs to redraw. task-table.test.ts fails the build if one does.
 */

/** The tab strip's own mark for each feed - a row says "Slack" the way its tab does. */
export const SOURCE_ICON = Object.fromEntries(
	FEED_TABS.map(({ to, Icon }) => [to, Icon]),
) as Record<FeedPath, IconType>;

/**
 * The asks whose timing is the point: their rows show the reason ("Ask 2h")
 * where the others show a priority - every reaction being High was a rule.
 */
const TIMED_ASKS = new Set<AllItem["ask"]["kind"]>([
	"asked",
	"mentioned",
	"review",
	"unread",
]);

/**
 * The columns, fixed widths shared with the header so every row lines up like
 * a table. Narrow lists drop whole columns - place first, then status, person
 * and date - rather than squeezing the title to nothing.
 */
export const ROW_GRID = "flex items-center gap-2.5";
export const COL = {
	lead: "flex w-[60px] shrink-0 items-center justify-end gap-1.5",
	task: "flex min-h-[30px] min-w-0 flex-1 flex-col justify-center",
	drop: "flex w-[92px] shrink-0 items-center",
	why: "flex w-[96px] shrink-0 items-center overflow-hidden",
	status:
		"flex w-[96px] shrink-0 items-center overflow-hidden @max-[1200px]:hidden",
	person:
		"flex w-[132px] shrink-0 items-center overflow-hidden @max-[1050px]:hidden",
	place: "block w-[112px] shrink-0 truncate @max-[1380px]:hidden",
	date: "flex w-[52px] shrink-0 items-center tabular-nums text-muted-foreground @max-[860px]:hidden",
	acts: "flex w-[128px] shrink-0 items-center justify-end gap-0.5",
	start: "flex w-[84px] shrink-0 justify-end",
	done: "flex w-[72px] shrink-0",
};

/** A row: a line with a divider, not a card - cards spent a third of the height on chrome. */
const TABLE_ROW =
	"group border-b border-border/70 px-3.5 py-1 transition-colors hover:bg-secondary/60";

/**
 * The scroller a table sits in: rows touch, and the columns answer to its width.
 * No top padding: a sticky header pins to the padding edge, so rows would show
 * through the gap above it.
 */
export const TABLE_LIST = cn(FEED_LIST, "@container gap-0 pt-0");

/** The column names, over the rows. */
export function TaskTableHeader({ date = "Updated" }: { date?: string }) {
	return (
		<div
			className={cn(
				ROW_GRID,
				"sticky top-0 z-[5] border-b border-border bg-background px-3.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-[.06em] text-faint-foreground",
			)}
		>
			<span className={COL.lead} />
			<span className={COL.task}>Task</span>
			<span className={COL.drop}>Sweep</span>
			<span className="flex shrink-0 items-center gap-3">
				<span className={COL.why}>Why</span>
				<span className={COL.status}>Status</span>
				<span className={COL.person}>From</span>
				<span className={COL.place}>Where</span>
				<span className={COL.date}>{date}</span>
			</span>
			<span className={COL.acts} />
			<span className={COL.start} />
			<span className={COL.done} />
		</div>
	);
}

/** Odin's status when there is one, the source's own otherwise. */
function RowStatus({
	odin,
	upstream,
}: {
	odin: string | null;
	upstream: string | null;
}) {
	if (odin)
		return (
			<span
				title={upstream ? `${upstream} upstream` : undefined}
				className={cn(
					"max-w-full truncate rounded-[5px] px-[7px] py-[1px] font-semibold",
					PILL.neutral,
				)}
			>
				{odin}
			</span>
		);
	return upstream ? (
		<span className={cn(ROW_META, "max-w-full truncate")}>{upstream}</span>
	) : null;
}

/**
 * What every row on a page shares - the launcher, Done, Read later, Up next,
 * Odin's statuses - read once per page rather than once per row.
 */
export function useTaskRows(onSlackStarted?: () => void) {
	const navigate = useNavigate();
	const start = useStartAllItem(onSlackStarted);
	const { markDone, markReading, undo, reading } = useDone();
	const { statuses, types, enqueue, dequeue } = useTaskMeta();
	const reminders = useReminders((s) => s.reminders);
	const readingKeys = useMemo(
		() => new Set(reading.map((row) => row.key)),
		[reading],
	);
	return {
		...start,
		statuses,
		types,
		reminders,
		readingKeys,
		enqueue,
		dequeue,
		markReading,
		undo,
		/** Done, and off Up next too, so an Undo doesn't bring it back there. */
		finish: (item: AllItem) => {
			markDone(item);
			dequeue(item.key);
		},
		goToPane: (paneId: string) => {
			usePendingFocus.getState().focus(paneId);
			navigate({ to: "/board" });
		},
		/** A feed tab has no side panel: its title opens the row in All's. */
		openInAll: (key: string) => navigate({ to: "/all", search: { open: key } }),
	};
}

export type TaskRows = ReturnType<typeof useTaskRows>;

export type SortableBits = {
	setNodeRef: (node: HTMLElement | null) => void;
	style: React.CSSProperties;
	attributes: ReturnType<typeof useSortable>["attributes"];
	listeners: ReturnType<typeof useSortable>["listeners"];
};

/** Up next's drag, around the same row everything else draws. */
export function SortableRow({
	id,
	children,
}: {
	id: string;
	children: (bits: SortableBits) => ReactNode;
}) {
	const { attributes, listeners, setNodeRef, transform, transition } =
		useSortable({ id });
	return children({
		setNodeRef,
		style: { transform: CSS.Transform.toString(transform), transition },
		attributes,
		listeners,
	});
}

/** One task, in the table's columns. */
export function TaskRow({
	item,
	rows,
	now,
	created = false,
	drag,
	select,
	open = false,
	onOpen,
	done = false,
}: {
	item: AllItem;
	rows: TaskRows;
	now: number;
	/** Show when it landed on your list, not when it last moved. */
	created?: boolean;
	/** Up next's handle and place. */
	drag?: SortableBits & { place: number };
	/** All's bulk-select tick box. */
	select?: { checked: boolean; onTick: (shift: boolean) => void };
	/** Its details are open beside the list. */
	open?: boolean;
	/** Default: open it in All's side panel. */
	onOpen?: () => void;
	/** Already done (Slack's Done view): Done reads as Undo. */
	done?: boolean;
}) {
	const url = item.url;
	const SourceIcon = SOURCE_ICON[item.to];
	const activePaneId = rows.livePaneFor(item);
	const isReading = rows.readingKeys.has(item.key);
	const due = effectiveDue(item.key, rows.reminders, item.dueDate);
	const band = bandOf(item, isDue(due, now), now, isReading);
	const timed = TIMED_ASKS.has(item.ask.kind);
	// A level the source itself set keeps its chip; a rule-made one doesn't.
	const rated =
		item.sourcePriority !== undefined
			? item.priority
			: timed
				? null
				: item.priority;
	// The second line: the comment that put it here, else the body - always
	// one line, so every row is the same height and the columns line up.
	const preview = item.mention
		? `${item.mention.author ?? "Someone"}: ${plainText(item.mention.text)}`
		: item.body
			? plainText(item.body)
			: "";
	const at = created ? item.createdAt : item.at;
	const type = typeOf(item, rows.types);
	const readLabel = isReading
		? "Back to Waiting on you"
		: "Mark it Read later - off the Night Agent";
	return (
		<div
			ref={drag?.setNodeRef}
			style={drag?.style}
			data-task-row={item.key}
			className={cn(
				TABLE_ROW,
				band === "now" && "shadow-[inset_2px_0_0_var(--attention)]",
				open && "bg-primary/10 hover:bg-primary/12",
				done && "opacity-60",
			)}
		>
			<div className={ROW_GRID}>
				<span className={COL.lead}>
					{drag && (
						<span
							{...drag.attributes}
							{...drag.listeners}
							title="Drag to reorder"
							className="flex cursor-grab items-center gap-1 text-[12px] font-semibold text-muted-foreground active:cursor-grabbing"
						>
							<span aria-hidden>⠿</span>
							{drag.place}
						</span>
					)}
					{select && (
						<input
							type="checkbox"
							aria-label={`Select ${item.title}`}
							title="Select - shift-click selects a range"
							checked={select.checked}
							onChange={() => {}}
							onClick={(event) => select.onTick(event.shiftKey)}
							className="size-3.5 cursor-pointer accent-primary"
						/>
					)}
					<SourceIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						title={item.source}
						aria-label={item.source}
					/>
				</span>
				<div className={COL.task}>
					<button
						type="button"
						title="Show details"
						onClick={onOpen ?? (() => rows.openInAll(item.key))}
						className="block w-full truncate bg-none text-left text-[13px] font-semibold text-foreground"
					>
						<OverdueMark itemKey={item.key} upstream={item.dueDate} />
						{emojify(item.title)}
						{type && (
							<span className="ml-2 text-[11px] font-normal text-muted-foreground">
								{typeLabel(type)}
							</span>
						)}
					</button>
					{preview && preview !== item.title.trim() && (
						<div
							dir="auto"
							title={preview}
							className="truncate text-[11.5px] text-muted-foreground"
						>
							{emojify(preview.slice(0, 300))}
						</div>
					)}
				</div>
				<span className={COL.drop}>
					<SweepDrop itemKey={item.key} url={item.url} />
				</span>
				<div className="flex shrink-0 items-center gap-3 text-[11px]">
					<span className={COL.why}>
						{timed ? (
							<span
								className={cn(
									"truncate text-muted-foreground",
									band === "now" && "font-semibold text-attention",
								)}
							>
								{reasonOf(item, now)}
							</span>
						) : (
							// Plain text like the reasons above it: a pill alone in a
							// column of words read as a stray badge.
							rated && (
								<span
									className={cn(
										"truncate text-muted-foreground",
										/^high/i.test(rated) && "font-semibold text-danger",
									)}
								>
									{rated}
								</span>
							)
						)}
					</span>
					<span className={COL.status}>
						<RowStatus
							odin={
								isReading ? "Read later" : statusLabel(rows.statuses[item.key])
							}
							upstream={item.status}
						/>
					</span>
					<span className={COL.person}>
						{item.person && (
							<PersonChip name={item.person} className="max-w-full truncate" />
						)}
					</span>
					<span
						className={cn(COL.place, "text-muted-foreground")}
						title={item.context ?? undefined}
					>
						{item.context}
					</span>
					<span className={COL.date}>
						{/* A due date wins the column; otherwise when it last moved. */}
						{due ? (
							<DueChip
								itemKey={item.key}
								title={item.title}
								upstream={item.dueDate}
							/>
						) : (
							at > 0 &&
							new Date(at).toLocaleDateString(undefined, {
								month: "short",
								day: "numeric",
							})
						)}
					</span>
				</div>
				{/* The quiet actions, always there as icons with an instant name:
				    hiding them until hover made the row's own data vanish. */}
				<span className={COL.acts}>
					{url ? (
						<IconTip label={`Open in ${item.source}`}>
							<button
								type="button"
								aria-label={`Open in ${item.source}`}
								onClick={() => openUrl(url)}
								className={ROW_ICON_BUTTON}
							>
								<LuExternalLink className="size-3.5" aria-hidden />
							</button>
						</IconTip>
					) : (
						<span className="size-6 shrink-0" />
					)}
					<DueChip
						iconOnly
						itemKey={item.key}
						title={item.title}
						upstream={item.dueDate}
					/>
					{drag ? (
						<IconTip label="Take it off Up next">
							<button
								type="button"
								onClick={() => rows.dequeue(item.key)}
								aria-label="Take it off Up next"
								className={cn(ROW_ICON_BUTTON, "text-primary")}
							>
								<LuListMinus className="size-3.5" aria-hidden />
							</button>
						</IconTip>
					) : (
						<IconTip label="Line it up - Up next">
							<button
								type="button"
								onClick={() => rows.enqueue(item.key)}
								aria-label="Line it up - Up next"
								className={ROW_ICON_BUTTON}
							>
								<LuListPlus className="size-3.5" aria-hidden />
							</button>
						</IconTip>
					)}
					<TonightButton item={item} iconOnly />
					<IconTip label={readLabel}>
						<button
							type="button"
							onClick={() =>
								isReading ? rows.undo(item) : rows.markReading(item)
							}
							aria-label={readLabel}
							aria-pressed={isReading}
							className={cn(ROW_ICON_BUTTON, isReading && "text-primary")}
						>
							<LuBookmark className="size-3.5" aria-hidden />
						</button>
					</IconTip>
				</span>
				<span className={COL.start}>
					{activePaneId ? (
						<button
							type="button"
							aria-label="Go to session"
							onClick={() => rows.goToPane(activePaneId)}
							className={cn(ROW_LIVE_BUTTON, "px-2.5")}
						>
							Session →
						</button>
					) : (
						<button
							type="button"
							aria-label="Start session"
							disabled={rows.isLaunching}
							onClick={() => void rows.start(item)}
							className={cn(ROW_START_BUTTON, "px-2.5")}
						>
							{rows.launchingKey === item.launch.key ? "Starting…" : "Start"}
						</button>
					)}
				</span>
				<span className={COL.done}>
					<DoneButton
						done={done}
						onClick={() => (done ? rows.undo(item) : rows.finish(item))}
					/>
				</span>
			</div>
		</div>
	);
}
