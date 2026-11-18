import { describe, expect, test } from "bun:test";
import {
	moveSelection,
	type SideRow,
	todaySide,
	UP_NEXT_SHOWN,
} from "./today-side";

const row = (key: string, extra: Partial<SideRow> = {}): SideRow => ({
	key,
	title: `Task ${key}`,
	source: "Tasks",
	url: null,
	due: null,
	started: false,
	...extra,
});

const days: Record<string, number> = {
	"2026-01-01": -2,
	"2026-01-03": 0,
	"2026-01-05": 2,
	"2026-01-20": 17,
};
const daysUntil = (day: string) => days[day] ?? 99;

describe("todaySide", () => {
	test("due lists late and this week's tasks, nearest first, not later ones", () => {
		const side = todaySide({
			rows: [
				row("later", { due: "2026-01-20" }),
				row("soon", { due: "2026-01-05" }),
				row("late", { due: "2026-01-01" }),
				row("today", { due: "2026-01-03" }),
				row("none"),
			],
			queue: [],
			waiting: {},
			daysUntil,
		});
		expect(side.due.map((r) => [r.key, r.daysLeft])).toEqual([
			["late", -2],
			["today", 0],
			["soon", 2],
		]);
	});

	test("up next keeps the queue's order, skips started, due and waiting rows", () => {
		const side = todaySide({
			rows: [
				row("a"),
				row("b", { started: true }),
				row("c", { due: "2026-01-03" }),
				row("d"),
				row("e"),
			],
			queue: ["e", "b", "c", "d", "gone", "a"],
			waiting: { d: { on: "Alex", until: "2026-01-05" } },
			daysUntil,
		});
		expect(side.upNext.map((r) => r.key)).toEqual(["e", "a"]);
	});

	test("up next shows only the top of the queue", () => {
		const keys = Array.from({ length: 9 }, (_, i) => `k${i}`);
		const side = todaySide({
			rows: keys.map((key) => row(key)),
			queue: keys,
			waiting: {},
			daysUntil,
		});
		expect(side.upNext).toHaveLength(UP_NEXT_SHOWN);
	});

	test("waiting lists every parked row, the one back first on top, never as due", () => {
		const side = todaySide({
			rows: [row("x", { due: "2026-01-01", url: "https://example.com/x" })],
			queue: [],
			waiting: {
				gone: { on: "", until: "2026-02-01", title: "Old ask" },
				x: { on: "Riley", until: "2026-01-04" },
			},
			daysUntil,
		});
		expect(side.due).toEqual([]);
		expect(side.waiting.map((w) => [w.key, w.title, w.on])).toEqual([
			["x", "Task x", "Riley"],
			["gone", "Old ask", ""],
		]);
		expect(side.waiting[0]?.url).toBe("https://example.com/x");
	});
});

describe("moveSelection", () => {
	test("down and up move within the rows and stop at the ends", () => {
		expect(moveSelection(1, -1, 3)).toBe(0);
		expect(moveSelection(1, 0, 3)).toBe(1);
		expect(moveSelection(1, 2, 3)).toBe(2);
		expect(moveSelection(-1, 2, 3)).toBe(1);
		expect(moveSelection(-1, 0, 3)).toBe(0);
		expect(moveSelection(-1, -1, 3)).toBe(0);
	});
	test("an empty page picks nothing", () => {
		expect(moveSelection(1, -1, 0)).toBeNull();
	});
});
