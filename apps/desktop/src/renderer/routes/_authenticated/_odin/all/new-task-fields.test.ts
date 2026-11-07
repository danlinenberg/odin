import { expect, test } from "bun:test";
import { useReminders } from "../components/Reminders";
import { applyNewTaskFields, NO_NEW_TASK_FIELDS } from "./new-task-fields";
import { useTaskMeta } from "./task-meta";

test("a new task's picks land on Up next, its due date, status and type", () => {
	useTaskMeta.setState({ queue: ["a", "b"], statuses: {}, types: {} });
	useReminders.getState().setProfile("new-task-fields");
	applyNewTaskFields("task:1", "Ship it", {
		upNext: "top",
		due: "2026-11-09",
		status: "in-progress",
		type: "code",
	});
	applyNewTaskFields("task:2", "Later", {
		...NO_NEW_TASK_FIELDS,
		upNext: "end",
	});
	const meta = useTaskMeta.getState();
	expect(meta.queue).toEqual(["task:1", "a", "b", "task:2"]);
	expect(meta.statuses).toEqual({ "task:1": "in-progress" });
	expect(meta.types).toEqual({ "task:1": "code" });
	expect(useReminders.getState().reminders).toEqual({
		"task:1": { due: "2026-11-09", title: "Ship it" },
	});
	useTaskMeta.setState({ queue: [] });
});

test("no picks set nothing", () => {
	useTaskMeta.setState({ queue: [], statuses: {}, types: {} });
	applyNewTaskFields("task:3", "Plain", NO_NEW_TASK_FIELDS);
	expect(useTaskMeta.getState().queue).toEqual([]);
	expect(useTaskMeta.getState().statuses).toEqual({});
});
