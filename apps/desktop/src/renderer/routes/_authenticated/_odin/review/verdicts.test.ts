import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "../hooks/builtin-automations";
import {
	countByVerdict,
	foldRepeats,
	keepDropped,
	reviewRows,
	type SweptRow,
	sessionFor,
} from "./verdicts";

const swept = (...verdicts: SweptRow["verdict"][]): SweptRow[] =>
	["task:a", "slack:C1:b", "task:c"]
		.slice(0, verdicts.length)
		.map((key, i) => ({
			key,
			source: "Tasks",
			title: key,
			verdict: verdicts[i],
			evidence: "",
		}));

const live = (...keys: string[]): BacklogItem[] =>
	keys.map((key) => ({ key, source: "", title: "" }));

describe("reviewRows", () => {
	test("numbers the rows as they were swept", () => {
		const rows = reviewRows(
			swept("KEEP", "DROP"),
			live("task:a", "slack:C1:b"),
		);
		expect(rows.map((r) => [r.key, r.n])).toEqual([
			["slack:C1:b", 2],
			["task:a", 1],
		]);
	});

	test("marks an item that has left the backlog since the sweep", () => {
		const rows = reviewRows(swept("DROP"), live("slack:C1:b"));
		expect(rows[0]?.stale).toBe(true);
	});

	test("doesn't mark a row whose feed hasn't answered yet", () => {
		const rows = reviewRows(swept("DROP", "DROP"), live(), new Set(["slack"]));
		expect(rows.find((r) => r.key === "task:a")?.stale).toBe(true);
		expect(rows.find((r) => r.key === "slack:C1:b")?.stale).toBe(false);
	});

	test("puts drops first, then unknowns, then keeps", () => {
		const rows = reviewRows(
			swept("KEEP", "UNKNOWN", "DROP"),
			live("task:a", "slack:C1:b", "task:c"),
		);
		expect(rows.map((r) => r.verdict)).toEqual(["DROP", "UNKNOWN", "KEEP"]);
	});
});

describe("countByVerdict", () => {
	test("counts by verdict, and a stale drop is not one to clear", () => {
		const rows = reviewRows(
			swept("DROP", "DROP", "KEEP"),
			live("slack:C1:b", "task:c"),
		);
		expect(countByVerdict(rows)).toEqual({ drop: 1, keep: 1, unknown: 0 });
	});
});

describe("sessionFor", () => {
	const row = (key: string, title = "t"): SweptRow => ({
		key,
		source: "",
		title,
		verdict: "DROP",
		evidence: "",
	});
	const none = new Map<string, string>();

	test("finds the live session by each launch link", () => {
		const live = [
			{ id: "p1", odinPageId: "C1:b" },
			{ id: "p2", odinTaskTitle: "BUG-1: crash" },
			{ id: "p3", odinTaskTitle: "odin#7: fix" },
			{ id: "p4", odinTaskTitle: "renamed" },
		];
		expect(sessionFor(row("slack:C1:b"), live, none)).toBe("p1");
		expect(sessionFor(row("jira:BUG-1"), live, none)).toBe("p2");
		expect(sessionFor(row("pr:odin#7"), live, none)).toBe("p3");
		expect(sessionFor(row("task:a"), live, new Map([["a", "p4"]]))).toBe("p4");
	});

	test("no session, no match — and BUG-1 doesn't claim BUG-10", () => {
		const live = [{ id: "p", odinTaskTitle: "BUG-10: other" }];
		expect(sessionFor(row("jira:BUG-1"), live, none)).toBeNull();
		expect(sessionFor(row("task:a"), [], new Map([["a", "p"]]))).toBeNull();
	});
});

describe("keepDropped", () => {
	test("a dropped row the sweep still lists outlives the cap", () => {
		const dropped = ["a", "b", "c", "d"].map((key) => ({ key }));
		const kept = keepDropped(dropped, [{ key: "c" }, { key: "d" }], 1);
		expect(kept.map((row) => row.key)).toEqual(["a", "c", "d"]);
	});
});

describe("foldRepeats", () => {
	const row = (key: string, evidence: string) => ({
		key,
		source: "Slack",
		title: key,
		verdict: "DROP" as const,
		evidence,
		n: 0,
		stale: false,
	});

	test("one row per DM answer, the rest folded into it", () => {
		const said = "you answered last in the DM: “מטורף”";
		const rows = foldRepeats([
			row("slack:D1:3", said),
			row("slack:C1:2", "you replied last in the thread"),
			row("slack:D1:2", said),
			row("slack:C1:1", "you replied last in the thread"),
			row("slack:D1:1", said),
			row("slack:D1:0", "nobody has replied"),
		]);
		expect(rows.map((r) => r.key)).toEqual([
			"slack:D1:3",
			"slack:C1:2",
			"slack:C1:1",
			"slack:D1:0",
		]);
		expect(rows[0].repeats?.map((r) => r.key)).toEqual([
			"slack:D1:2",
			"slack:D1:1",
		]);
	});
});
