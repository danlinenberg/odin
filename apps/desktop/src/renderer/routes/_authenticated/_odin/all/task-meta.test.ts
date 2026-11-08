import { expect, test } from "bun:test";
import {
	moveKey,
	parseDueDay,
	parseQueuePlace,
	placeKey,
	typeOf,
	useTaskMeta,
} from "./task-meta";

test("moveKey drops the dragged key where the target was", () => {
	expect(moveKey(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
	expect(moveKey(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
	expect(moveKey(["a", "b"], "x", "a")).toEqual(["a", "b"]);
});

test("a PR reads as a review until you pick a type", () => {
	expect(typeOf({ key: "pr:1", source: "GitHub" }, {})).toBe("review");
	expect(typeOf({ key: "pr:1", source: "GitHub" }, { "pr:1": "read" })).toBe(
		"read",
	);
	expect(typeOf({ key: "task:1", source: "Tasks" }, {})).toBeUndefined();
});

test("placeKey puts a row at the top, the end or a place, once", () => {
	const q = ["a", "b", "c"];
	expect(placeKey(q, "x", "top")).toEqual(["x", "a", "b", "c"]);
	expect(placeKey(q, "x", "end")).toEqual(["a", "b", "c", "x"]);
	expect(placeKey(q, "x", 2)).toEqual(["a", "x", "b", "c"]);
	expect(placeKey(q, "x", 1)).toEqual(["x", "a", "b", "c"]);
	// Past the end is the end.
	expect(placeKey(q, "x", 99)).toEqual(["a", "b", "c", "x"]);
	// Already lined up: moved, not listed twice.
	expect(placeKey(q, "c", "top")).toEqual(["c", "a", "b"]);
	expect(placeKey(q, "a", 2)).toEqual(["b", "a", "c"]);
	expect(placeKey([], "x", 3)).toEqual(["x"]);
});

test("placeKey keeps the new row when the queue is full", () => {
	const full = Array.from({ length: 500 }, (_, i) => `k${i}`);
	const top = placeKey(full, "x", "top");
	expect(top).toHaveLength(500);
	expect(top[0]).toBe("x");
	expect(top.at(-1)).toBe("k498");
	const end = placeKey(full, "x", "end");
	expect(end).toHaveLength(500);
	expect(end.at(-1)).toBe("x");
	expect(end[0]).toBe("k1");
});

test("parseQueuePlace reads top, end or a place from 1", () => {
	expect(parseQueuePlace(undefined)).toBeUndefined();
	expect(parseQueuePlace("  ")).toBeUndefined();
	expect(parseQueuePlace("top")).toBe("top");
	expect(parseQueuePlace(" END ")).toBe("end");
	expect(parseQueuePlace("3")).toBe(3);
	expect(parseQueuePlace("0")).toBeNull();
	expect(parseQueuePlace("1.5")).toBeNull();
	expect(parseQueuePlace("head")).toBeNull();
});

test("parseDueDay reads a real YYYY-MM-DD day", () => {
	expect(parseDueDay(undefined)).toBeUndefined();
	expect(parseDueDay(" ")).toBeUndefined();
	expect(parseDueDay(" 2026-11-12 ")).toBe("2026-11-12");
	expect(parseDueDay("2028-02-29")).toBe("2028-02-29");
	expect(parseDueDay("2026-02-30")).toBeNull();
	expect(parseDueDay("2026-13-01")).toBeNull();
	expect(parseDueDay("12/11/2026")).toBeNull();
	expect(parseDueDay("tomorrow")).toBeNull();
});

test("enqueueAt lines a row up at the place asked", () => {
	useTaskMeta.setState({ queue: ["a", "b"] });
	useTaskMeta.getState().enqueueAt("task:1", "top");
	useTaskMeta.getState().enqueueAt("task:2", 2);
	expect(useTaskMeta.getState().queue).toEqual(["task:1", "task:2", "a", "b"]);
	useTaskMeta.setState({ queue: [] });
});

test("setNote keeps notes on any row, and empty clears them", () => {
	useTaskMeta.setState({ notes: {} });
	useTaskMeta.getState().setNote("slack:C1/123", "  ask Dana first  ");
	useTaskMeta.getState().setNote("jira:A-1", "blocked on infra");
	expect(useTaskMeta.getState().notes).toEqual({
		"slack:C1/123": "ask Dana first",
		"jira:A-1": "blocked on infra",
	});
	useTaskMeta.getState().setNote("jira:A-1", "  ");
	expect(useTaskMeta.getState().notes).toEqual({
		"slack:C1/123": "ask Dana first",
	});
	useTaskMeta.setState({ notes: {} });
});
