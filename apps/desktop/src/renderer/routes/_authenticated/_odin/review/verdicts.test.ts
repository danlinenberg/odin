import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "../hooks/builtin-automations";
import { countByVerdict, reviewRows, type SweptItem } from "./verdicts";

const swept: SweptItem[] = [
	{ key: "task:a", source: "Tasks", title: "first" },
	{ key: "slack:b", source: "#eng", title: "second" },
	{ key: "task:c", source: "Tasks", title: "third" },
];

const live = (...keys: string[]): BacklogItem[] =>
	keys.map((key) => ({ key, source: "", title: "", at: 0 }));

const all = live("task:a", "slack:b", "task:c");

describe("reviewRows", () => {
	test("joins a verdict onto the item at that position", () => {
		const rows = reviewRows(
			swept,
			[{ n: 2, verdict: "DROP", evidence: "thread answered" }],
			all,
		);
		expect(rows).toEqual([
			{
				key: "slack:b",
				source: "#eng",
				title: "second",
				n: 2,
				verdict: "DROP",
				evidence: "thread answered",
				stale: false,
			},
		]);
	});

	test("leaves out items the sweep never answered", () => {
		const rows = reviewRows(
			swept,
			[{ n: 1, verdict: "KEEP", evidence: "" }],
			all,
		);
		expect(rows.map((r) => r.key)).toEqual(["task:a"]);
	});

	test("ignores a number no item has", () => {
		expect(
			reviewRows(swept, [{ n: 99, verdict: "DROP", evidence: "" }], all),
		).toEqual([]);
	});

	test("marks an item that has left the backlog since the sweep", () => {
		const rows = reviewRows(
			swept,
			[{ n: 1, verdict: "DROP", evidence: "merged" }],
			live("slack:b", "task:c"),
		);
		expect(rows[0]?.stale).toBe(true);
	});

	test("puts drops first, then unknowns, then keeps", () => {
		const rows = reviewRows(
			swept,
			[
				{ n: 1, verdict: "KEEP", evidence: "" },
				{ n: 2, verdict: "UNKNOWN", evidence: "" },
				{ n: 3, verdict: "DROP", evidence: "" },
			],
			all,
		);
		expect(rows.map((r) => r.verdict)).toEqual(["DROP", "UNKNOWN", "KEEP"]);
	});
});

describe("countByVerdict", () => {
	test("counts by verdict, and a stale drop is not one to clear", () => {
		const rows = reviewRows(
			swept,
			[
				{ n: 1, verdict: "DROP", evidence: "" },
				{ n: 2, verdict: "DROP", evidence: "" },
				{ n: 3, verdict: "KEEP", evidence: "" },
			],
			live("slack:b", "task:c"),
		);
		expect(countByVerdict(rows)).toEqual({ drop: 1, keep: 1, unknown: 0 });
	});
});
