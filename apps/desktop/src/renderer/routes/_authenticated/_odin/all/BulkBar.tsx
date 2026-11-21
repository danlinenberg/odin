import { toast } from "@odin/ui/sonner";
import { type ReactNode, useState } from "react";
import { DoneButton } from "../components/DoneButton";
import { DROP_LABEL, useDropMany } from "../components/DropHint";
import {
	FeedSelect,
	ROW_LINK_BUTTON,
	ROW_START_BUTTON,
} from "../components/FeedChrome";
import { useReminders } from "../components/Reminders";
import { guardTasksDone } from "../hooks/done-guard";
import { useDone } from "../hooks/useDone";
import type { AllItem } from "./all-items";
import { useMetaOptions } from "./MetaOptionSelect";
import { mergeTicked } from "./manual-merges";
import { nextSelection, visibleSelection } from "./selection";
import type { BulkActions } from "./TaskRowMenu";
import type { TaskRows } from "./TaskTable";
import { dayAfter, type TaskStatus, useTaskMeta, WAIT_DAYS } from "./task-meta";

/**
 * Ticked rows on a task list (All and every feed tab), for acting on many at
 * once: the bar over the list and a ticked row's right-click run the same
 * actions. Only rows still on screen count: a filter or a Done that hides a
 * ticked row takes it out of the next action.
 */
export function useBulkTicks(
	items: readonly AllItem[],
	rows: TaskRows,
	/** `merge`: offer Merge with two or more ticked (All, where merged rows show). */
	options: { merge?: boolean } = {},
) {
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [anchor, setAnchor] = useState<string | null>(null);
	const { set: setDone } = useDone();
	const { setStatus, enqueueAt, dequeue, wait } = useTaskMeta();
	const dropMany = useDropMany();
	const taskStatuses = useMetaOptions("status");
	const visibleKeys = items.map((item) => item.key);
	const picked = visibleSelection(selected, visibleKeys);
	const pickedRows = () => items.filter((item) => selected.has(item.key));
	const tick = (key: string, shift: boolean) => {
		setSelected(nextSelection(selected, visibleKeys, key, shift, anchor));
		setAnchor(key);
	};
	const clear = () => setSelected(new Set());
	// One toast for the lot, and one Undo that brings every row back. Unticked
	// to-dos in a session on any of them ask first, once for the lot.
	const done = () => {
		const went = pickedRows();
		guardTasksDone(went, () => finish(went));
	};
	const finish = (went: AllItem[]) => {
		for (const item of went) {
			setDone(item, true);
			dequeue(item.key);
		}
		toast.success(
			`Done - ${went.length} ${went.length === 1 ? "task" : "tasks"}`,
			{
				action: {
					label: "Undo",
					onClick: () => {
						for (const item of went) setDone(item, false);
					},
				},
			},
		);
		clear();
	};
	// The row's own Drop, on every ticked row: Done everywhere and listed under
	// Review's Dropped, with one Undo for the lot.
	const drop = () => {
		const went = pickedRows();
		for (const item of went) dequeue(item.key);
		void dropMany(went);
		clear();
	};
	const upNext = (place: "top" | "end" = "end") => {
		// Placed at the top one by one, the last lands first: go bottom-up.
		const keys = place === "top" ? [...picked].reverse() : picked;
		for (const key of keys) enqueueAt(key, place);
		clear();
	};
	const waitAll = (days = WAIT_DAYS) => {
		const until = dayAfter(Date.now(), days);
		for (const item of pickedRows()) wait(item.key, "", until, item.title);
		clear();
	};
	const start = () => {
		void rows.startMany(pickedRows()).then((went) => went && clear());
	};
	const due = (day: string | null) => {
		const { setDue, clear: clearDue } = useReminders.getState();
		for (const item of pickedRows())
			day ? setDue(item.key, day, item.title) : clearDue(item.key);
		clear();
	};
	// Two or more into one row that keeps every source's link and your notes
	// on each. Undo on the toast, or Split on the row, takes it apart.
	const merge = () => {
		const undo = mergeTicked(pickedRows());
		if (!undo) return;
		toast.success(`Merged ${picked.length} tasks into one`, {
			action: { label: "Undo", onClick: undo },
		});
		clear();
	};
	const canMerge = options.merge === true && picked.length > 1;
	const bulk: BulkActions = {
		count: picked.length,
		upNext,
		wait: waitAll,
		due,
		start,
		done,
		drop,
		merge: canMerge ? merge : undefined,
		clear,
	};

	/** What TaskRow takes for its tick box and its right-click. */
	const rowProps = (item: AllItem) => ({
		select: {
			checked: selected.has(item.key),
			onTick: (shift: boolean) => tick(item.key, shift),
		},
		bulk: picked.length > 1 && picked.includes(item.key) ? bulk : undefined,
	});

	const bar: ReactNode =
		picked.length > 0 ? (
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
							setStatus(
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
					{taskStatuses.map(({ id, label }) => (
						<option key={id} value={id}>
							{label}
						</option>
					))}
				</FeedSelect>
				<button
					type="button"
					onClick={() => upNext()}
					title="Line them all up - Up next, above the list"
					className={ROW_LINK_BUTTON}
				>
					Up next
				</button>
				<button
					type="button"
					onClick={() => waitAll()}
					title={`Waiting on someone else - back on Up next in ${WAIT_DAYS} days`}
					className={ROW_LINK_BUTTON}
				>
					Waiting
				</button>
				<button
					type="button"
					onClick={drop}
					title={DROP_LABEL}
					className={`${ROW_LINK_BUTTON} hover:text-danger`}
				>
					Drop
				</button>
				<button
					type="button"
					disabled={rows.isLaunching}
					onClick={start}
					title="Start a session on each selected row - pick here or remote once for all"
					className={ROW_START_BUTTON}
				>
					Start {picked.length}
				</button>
				{canMerge && (
					<button
						type="button"
						onClick={merge}
						title="Merge the selected tasks into one row - every source's link and your notes stay, Undo or Split brings them back"
						className={ROW_LINK_BUTTON}
					>
						Merge
					</button>
				)}
				<DoneButton onClick={done} />
				<button type="button" onClick={clear} className={ROW_LINK_BUTTON}>
					Clear
				</button>
			</div>
		) : null;

	return { picked, rowProps, bar, clear };
}
