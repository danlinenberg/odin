import { expect, test } from "bun:test";
import { dueText, taskSections } from "./tasks";

test("Up next in its order first, then the rest by priority, ties in list order", () => {
	const sections = taskSections([
		{ id: "a", title: "a", priority: 1 },
		{ id: "b", title: "b", upNext: 1 },
		{ id: "c", title: "c", priority: 3 },
		{ id: "d", title: "d" },
		{ id: "e", title: "e", upNext: 0 },
		{ id: "f", title: "f", priority: 2 },
	]);
	expect(sections.map((s) => [s.key, s.rows.map((r) => r.id)])).toEqual([
		["upnext", ["e", "b"]],
		["tasks", ["c", "d", "f", "a"]],
	]);
});

test("no Up next section when nothing is lined up", () => {
	expect(taskSections([{ id: "a", title: "a" }]).map((s) => s.key)).toEqual([
		"tasks",
	]);
});

test("due reads as the desktop chip", () => {
	const now = new Date(2026, 10, 20, 15).getTime();
	expect(dueText("2026-11-19", now)).toEqual({ text: "Overdue", late: true });
	expect(dueText("2026-11-20", now)).toEqual({ text: "Today", late: true });
	expect(dueText("2026-11-21", now)).toEqual({ text: "Tomorrow", late: false });
	expect(dueText("2026-11-30", now).late).toBe(false);
});
