import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AllItem } from "./all-items";
import { TASK_STATUSES, TASK_TYPES, type TaskType, typeOf } from "./task-meta";

/**
 * Tasks -> All as a board: one column per value of the field picked in
 * "Group by", each task a card in its column. The list stays the default.
 */
export type TaskView = "list" | "board";
export type GroupBy = "type" | "status" | "priority";

export const GROUP_BYS: { id: GroupBy; label: string }[] = [
	{ id: "type", label: "Type" },
	{ id: "status", label: "Status" },
	{ id: "priority", label: "Priority" },
];

/** A column's id is the field's value; "" is the column for rows without one. */
export interface BoardColumn {
	id: string;
	label: string;
	items: AllItem[];
}

const COLUMNS: Record<GroupBy, { id: string; label: string }[]> = {
	type: [...TASK_TYPES, { id: "", label: "No type" }],
	status: [{ id: "waiting", label: "Waiting on you" }, ...TASK_STATUSES],
	priority: [
		{ id: "high", label: "High" },
		{ id: "medium", label: "Medium" },
		{ id: "low", label: "Low" },
		{ id: "", label: "No priority" },
	],
};

/**
 * The rows, split into the picked field's columns in a fixed order (every
 * column shows, empty ones too, so a card can be dragged into it). Rows keep
 * their order inside a column. `statusOf` is Odin's own status, "waiting" when
 * none is set.
 */
export function groupTasks(
	items: AllItem[],
	groupBy: GroupBy,
	meta: {
		types: Record<string, TaskType>;
		statusOf: (item: AllItem) => string;
	},
): BoardColumn[] {
	const columns = COLUMNS[groupBy].map((column) => ({
		...column,
		items: [] as AllItem[],
	}));
	const byId = new Map(columns.map((column) => [column.id, column]));
	const fieldOf = (item: AllItem): string =>
		groupBy === "type"
			? (typeOf(item, meta.types) ?? "")
			: groupBy === "status"
				? meta.statusOf(item)
				: (item.urgency ?? "");
	for (const item of items) {
		// A value with no column of its own (an old status) goes in the first.
		(byId.get(fieldOf(item)) ?? columns[0]).items.push(item);
	}
	return columns;
}

/** List or Board, and the board's Group by: one small record, kept. */
export const useTaskView = create<{
	view: TaskView;
	groupBy: GroupBy;
	setView: (view: TaskView) => void;
	setGroupBy: (groupBy: GroupBy) => void;
}>()(
	persist(
		(set) => ({
			view: "list",
			groupBy: "type",
			setView: (view) => set({ view }),
			setGroupBy: (groupBy) => set({ groupBy }),
		}),
		{ name: "odin.all.view" },
	),
);
