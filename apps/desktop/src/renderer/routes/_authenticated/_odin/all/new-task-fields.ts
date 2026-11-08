import { useReminders } from "../components/Reminders";
import { type TaskStatus, type TaskType, useTaskMeta } from "./task-meta";

/**
 * What the side panel sets on a task, picked while you write it: Up next
 * (start or end of the queue), a due date, status and type. Priority isn't
 * here - the box writes it into the text as "!"s.
 */
export interface NewTaskFields {
	upNext: "" | "top" | "end";
	/** `YYYY-MM-DD`, or "" for none. */
	due: string;
	status: TaskStatus | "";
	type: TaskType | "";
}

export const NO_NEW_TASK_FIELDS: NewTaskFields = {
	upNext: "",
	due: "",
	status: "",
	type: "",
};

/** Set the picks on the row `key` (`task:<id>`), the same stores the panel writes. */
export function applyNewTaskFields(
	key: string,
	title: string,
	fields: NewTaskFields,
): void {
	const meta = useTaskMeta.getState();
	if (fields.upNext) meta.enqueueAt(key, fields.upNext);
	if (fields.status) meta.setStatus(key, fields.status);
	if (fields.type) meta.setType(key, fields.type);
	if (fields.due) useReminders.getState().setDue(key, fields.due, title);
}
