import {
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@odin/ui/context-menu";
import type { ReactNode } from "react";
import { openUrl } from "renderer/stores/in-app-browser";
import {
	canPickForTonight,
	MAX_NIGHT_PICKS,
	toggleNightPick,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useNightAgentIntro } from "../board/NightAgentIntro";
import { DROP_LABEL } from "../components/DropHint";
import { useReminders } from "../components/Reminders";
import type { AllItem } from "./all-items";
import { DropRuleMenu, WAITS } from "./DropRuleMenu";
import type { TaskRows } from "./TaskTable";
import { dayAfter, type QueuePlace, useTaskMeta } from "./task-meta";

/**
 * What All's bulk bar does to the ticked rows, for the right-click menu of
 * one of them: the same handlers, so the menu and the bar can't drift.
 */
export interface BulkActions {
	count: number;
	upNext: (place: Exclude<QueuePlace, number>) => void;
	wait: (days: number) => void;
	/** A local `YYYY-MM-DD`, or null to drop the due dates set in Odin. */
	due: (day: string | null) => void;
	start: () => void;
	done: () => void;
	clear: () => void;
}

/** The quick due dates; any other day is the row's calendar icon. */
const DUES: { days: number; label: string }[] = [
	{ days: 0, label: "Today" },
	{ days: 1, label: "Tomorrow" },
	{ days: 7, label: "In a week" },
];

const ITEM = "text-[12px]";

/**
 * Right-click a task row: everything its icons do, then the drop rules. With
 * several rows ticked and this one among them, the actions that make sense
 * for many apply to every ticked row, as the bulk bar does.
 */
export function TaskRowMenu({
	item,
	rows,
	done,
	bulk,
	children,
}: {
	item: AllItem;
	rows: TaskRows;
	done: boolean;
	bulk?: BulkActions;
	children: ReactNode;
}) {
	// Outside the menu: the first pick's notice outlives the menu closing.
	const nightIntro = useNightAgentIntro();
	return (
		<>
			<DropRuleMenu
				item={item}
				actions={
					bulk ? (
						<BulkItems bulk={bulk} />
					) : (
						<RowItems
							item={item}
							rows={rows}
							done={done}
							gate={nightIntro.gate}
						/>
					)
				}
			>
				{children}
			</DropRuleMenu>
			{nightIntro.dialog}
		</>
	);
}

/** One row's actions, in the order its icons and buttons sit. */
function RowItems({
	item,
	rows,
	done,
	gate,
}: {
	item: AllItem;
	rows: TaskRows;
	done: boolean;
	gate: (action: () => void) => void;
}) {
	const queued = useTaskMeta((s) => s.queue.includes(item.key));
	const { enqueueAt, dequeue, wait, unwait } = useTaskMeta.getState();
	const reminder = useReminders((s) => s.reminders[item.key]);
	const picked = useNextInLinePrompt((s) => s.offHours.picked);
	const activePaneId = rows.livePaneFor(item);
	const isReading = rows.readingKeys.has(item.key);
	const waiting = rows.waiting[item.key];
	const url = item.url;
	const tonight = picked.includes(item.key);
	const tonightFull = !tonight && picked.length >= MAX_NIGHT_PICKS;
	const setDue = (days: number) =>
		useReminders
			.getState()
			.setDue(item.key, dayAfter(Date.now(), days), item.title);
	return (
		<>
			{activePaneId ? (
				<ContextMenuItem
					onSelect={() => rows.goToPane(activePaneId)}
					className={ITEM}
				>
					Go to session
				</ContextMenuItem>
			) : (
				<ContextMenuItem
					disabled={rows.isLaunching}
					onSelect={() => void rows.start(item)}
					className={ITEM}
				>
					Start session
				</ContextMenuItem>
			)}
			<ContextMenuItem
				onSelect={() => (done ? rows.undo(item) : rows.finish(item))}
				className={ITEM}
			>
				{done ? "Move back to the queue" : "Done"}
			</ContextMenuItem>
			{url && (
				<ContextMenuItem onSelect={() => openUrl(url)} className={ITEM}>
					Open in {item.source}
				</ContextMenuItem>
			)}
			<ContextMenuSeparator />
			{waiting ? (
				<ContextMenuItem
					onSelect={() => unwait(item.key, true)}
					className={ITEM}
				>
					Stop waiting - back on top of Up next
				</ContextMenuItem>
			) : queued ? (
				<>
					<ContextMenuItem
						onSelect={() => enqueueAt(item.key, "top")}
						className={ITEM}
					>
						Move to the top of Up next
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => dequeue(item.key)} className={ITEM}>
						Take it off Up next
					</ContextMenuItem>
				</>
			) : (
				<>
					<ContextMenuItem
						onSelect={() => enqueueAt(item.key, "top")}
						className={ITEM}
					>
						Line it up - top of Up next
					</ContextMenuItem>
					<ContextMenuItem
						onSelect={() => enqueueAt(item.key, "end")}
						className={ITEM}
					>
						Line it up - end of Up next
					</ContextMenuItem>
				</>
			)}
			{!waiting && (
				<WaitSub
					onPick={(days) =>
						wait(item.key, "", dayAfter(Date.now(), days), item.title)
					}
				/>
			)}
			<ContextMenuSub>
				<ContextMenuSubTrigger className={ITEM}>
					{reminder ? `Due ${reminder.due}` : "Set a due date"}
				</ContextMenuSubTrigger>
				<ContextMenuSubContent>
					{DUES.map(({ days, label }) => (
						<ContextMenuItem
							key={days}
							onSelect={() => setDue(days)}
							className={ITEM}
						>
							{label}
						</ContextMenuItem>
					))}
					{reminder && (
						<ContextMenuItem
							onSelect={() => useReminders.getState().clear(item.key)}
							className={ITEM}
						>
							{item.dueDate
								? `Drop yours - back to ${item.source}'s ${item.dueDate}`
								: "Drop the due date"}
						</ContextMenuItem>
					)}
				</ContextMenuSubContent>
			</ContextMenuSub>
			<ContextMenuSeparator />
			{canPickForTonight(item) && (
				<ContextMenuItem
					disabled={tonightFull}
					onSelect={() =>
						tonight
							? toggleNightPick(item.key)
							: gate(() => toggleNightPick(item.key))
					}
					className={ITEM}
				>
					{tonight
						? "Take off tonight's picks"
						: tonightFull
							? `Tonight's picks are full (${MAX_NIGHT_PICKS})`
							: "Pick for tonight"}
				</ContextMenuItem>
			)}
			<ContextMenuItem
				onSelect={() => (isReading ? rows.undo(item) : rows.markReading(item))}
				className={ITEM}
			>
				{isReading ? "Back to Waiting on you" : "Mark it Read later"}
			</ContextMenuItem>
			<ContextMenuItem
				onSelect={() => rows.drop(item)}
				title={DROP_LABEL}
				className={ITEM}
			>
				Drop it
			</ContextMenuItem>
		</>
	);
}

/** The ticked rows' actions: the bulk bar's, said with how many. */
function BulkItems({ bulk }: { bulk: BulkActions }) {
	const n = bulk.count;
	return (
		<>
			<ContextMenuLabel className="text-[11px] text-muted-foreground">
				{n} selected
			</ContextMenuLabel>
			<ContextMenuItem onSelect={bulk.start} className={ITEM}>
				Start {n} sessions
			</ContextMenuItem>
			<ContextMenuItem onSelect={bulk.done} className={ITEM}>
				Done - {n} tasks
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onSelect={() => bulk.upNext("top")} className={ITEM}>
				Line {n} up - top of Up next
			</ContextMenuItem>
			<ContextMenuItem onSelect={() => bulk.upNext("end")} className={ITEM}>
				Line {n} up - end of Up next
			</ContextMenuItem>
			<WaitSub onPick={bulk.wait} />
			<ContextMenuSub>
				<ContextMenuSubTrigger className={ITEM}>
					Set a due date on {n}
				</ContextMenuSubTrigger>
				<ContextMenuSubContent>
					{DUES.map(({ days, label }) => (
						<ContextMenuItem
							key={days}
							onSelect={() => bulk.due(dayAfter(Date.now(), days))}
							className={ITEM}
						>
							{label}
						</ContextMenuItem>
					))}
					<ContextMenuItem onSelect={() => bulk.due(null)} className={ITEM}>
						Drop the due dates
					</ContextMenuItem>
				</ContextMenuSubContent>
			</ContextMenuSub>
			<ContextMenuSeparator />
			<ContextMenuItem onSelect={bulk.clear} className={ITEM}>
				Clear selection
			</ContextMenuItem>
		</>
	);
}

/** "Waiting on someone else", folded: the three quick days. */
function WaitSub({ onPick }: { onPick: (days: number) => void }) {
	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger className={ITEM}>
				Waiting on someone else
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				{WAITS.map(({ days, label }) => (
					<ContextMenuItem
						key={days}
						onSelect={() => onPick(days)}
						className={ITEM}
					>
						{label}
					</ContextMenuItem>
				))}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}
