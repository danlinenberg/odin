import { describe, expect, test } from "bun:test";
import type { AllItem } from "./all-items";
import { groupTasks } from "./task-board";
import type { TaskType } from "./task-meta";

const row = (key: string, extra: Partial<AllItem> = {}) =>
	({ key, source: "Tasks", title: key, urgency: null, ...extra }) as AllItem;

const cards = (columns: ReturnType<typeof groupTasks>) =>
	Object.fromEntries(
		columns.map((column) => [
			column.label,
			column.items.map((item) => item.key),
		]),
	);

describe("groupTasks", () => {
	const types: Record<string, TaskType> = { a: "code", c: "read" };
	const statuses: Record<string, string> = { b: "in-review" };
	const meta = {
		types,
		statusOf: (item: AllItem) => statuses[item.key] ?? "waiting",
	};

	test("by type: your pick, else what the source implies, else No type", () => {
		const items = [
			row("a"),
			row("b"),
			row("c"),
			row("pr", { source: "GitHub" }),
			row("meet", { source: "Calendar" }),
		];
		expect(cards(groupTasks(items, "type", meta))).toEqual({
			"Prepare for meeting": ["meet"],
			"Write code": ["a"],
			"Review code": ["pr"],
			Read: ["c"],
			"No type": ["b"],
		});
	});

	test("by status: every column shows, empty ones too, in a fixed order", () => {
		const columns = groupTasks([row("a"), row("b")], "status", meta);
		expect(columns.map((column) => column.id)).toEqual([
			"waiting",
			"backlog",
			"prioritised",
			"in-progress",
			"in-review",
			"on-hold",
		]);
		expect(cards(columns)["Waiting on you"]).toEqual(["a"]);
		expect(cards(columns)["In review"]).toEqual(["b"]);
	});

	test("by priority: high, medium, low, then unrated; order kept inside a column", () => {
		const items = [
			row("x", { urgency: "low" }),
			row("y", { urgency: "high" }),
			row("z"),
			row("w", { urgency: "high" }),
		];
		expect(cards(groupTasks(items, "priority", meta))).toEqual({
			High: ["y", "w"],
			Medium: [],
			Low: ["x"],
			"No priority": ["z"],
		});
	});

	test("a status with no column of its own lands in the first column", () => {
		const columns = groupTasks([row("old")], "status", {
			types: {},
			statusOf: () => "gone",
		});
		expect(columns[0].items.map((item) => item.key)).toEqual(["old"]);
	});
});
