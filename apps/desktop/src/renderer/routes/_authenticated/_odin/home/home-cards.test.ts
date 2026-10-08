import { describe, expect, it } from "bun:test";
import type { Pane, PaneStatus } from "renderer/stores/tabs/types";
import { HOME_LIMIT, homeCards, homeGrid } from "./home-cards";

const pane = (id: string, fields: Partial<Pane> = {}): Pane => ({
	id,
	tabId: `tab-${id}`,
	type: "terminal",
	name: id,
	...fields,
});

/** Stands in for the board's column: whatever the test filed the pane under. */
const columnOf = (pane: Pane): PaneStatus => pane.status ?? "idle";

const ids = (result: ReturnType<typeof homeCards>) =>
	result.cards.map((card) => card.pane.id);

describe("homeCards", () => {
	it("keeps the board's Working and Needs you, and leaves Done and Idle out", () => {
		const panes = [
			pane("working", { status: "working" }),
			pane("asking", { status: "permission" }),
			pane("done", { status: "review" }),
			pane("idle", { status: "idle" }),
		];
		const result = homeCards(panes, columnOf, new Set(panes.map((p) => p.id)));
		expect(ids(result).sort()).toEqual(["asking", "working"]);
	});

	// The board's column, not the pane's status: a /loop session between ticks
	// reads "review" on the pane but sits in Idle on the board.
	it("files a session under the column the board gives it", () => {
		const result = homeCards(
			[pane("looping", { status: "review" })],
			() => "idle",
			new Set(["looping"]),
		);
		expect(result.cards).toEqual([]);
	});

	it("leaves out a completed session the board keeps off", () => {
		const result = homeCards(
			[pane("gone", { status: "permission", completed: true })],
			columnOf,
			new Set(),
		);
		expect(result.cards).toEqual([]);
	});

	it("puts Needs you first, then Working, newest first within each", () => {
		const panes = [
			pane("old-working", { status: "working", odinStatusAt: 1 }),
			pane("new-working", { status: "working", odinStatusAt: 5 }),
			pane("old-asking", { status: "permission", odinStatusAt: 2 }),
			pane("new-asking", { status: "permission", odinStatusAt: 4 }),
		];
		const result = homeCards(panes, columnOf, new Set(panes.map((p) => p.id)));
		expect(ids(result)).toEqual([
			"new-asking",
			"old-asking",
			"new-working",
			"old-working",
		]);
	});

	it(`shows ${HOME_LIMIT} and counts the rest`, () => {
		const panes = Array.from({ length: 9 }, (_, i) =>
			pane(`p${i}`, { status: "working", odinStatusAt: i }),
		);
		const result = homeCards(panes, columnOf, new Set(panes.map((p) => p.id)));
		expect(result.cards).toHaveLength(HOME_LIMIT);
		expect(result.more).toBe(3);
		expect(ids(result)[0]).toBe("p8");
	});

	it("has nothing more when everything fits", () => {
		expect(homeCards([], columnOf, new Set()).more).toBe(0);
	});
});

describe("homeGrid", () => {
	it("fills the page with one, splits two, then 2x2 and 3x2", () => {
		expect([1, 2, 3, 4, 5, 6].map(homeGrid)).toEqual([
			{ cols: 1, rows: 1 },
			{ cols: 2, rows: 1 },
			{ cols: 2, rows: 2 },
			{ cols: 2, rows: 2 },
			{ cols: 3, rows: 2 },
			{ cols: 3, rows: 2 },
		]);
	});
});
