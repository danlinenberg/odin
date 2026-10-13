import { describe, expect, it } from "bun:test";
import type { Pane, PaneStatus } from "renderer/stores/tabs/types";
import { homeCards, homeGrid, homeOrder, moveCard } from "./home-cards";

const pane = (id: string, fields: Partial<Pane> = {}): Pane => ({
	id,
	tabId: `tab-${id}`,
	type: "terminal",
	name: id,
	...fields,
});

/** Stands in for the board's column: whatever the test filed the pane under. */
const columnOf = (pane: Pane): PaneStatus => pane.status ?? "idle";

const ids = (cards: ReturnType<typeof homeCards>) =>
	cards.map((card) => card.pane.id);

describe("homeCards", () => {
	it("keeps the board's Working and Needs you, and leaves Done and Idle out", () => {
		const panes = [
			pane("working", { status: "working" }),
			pane("asking", { status: "permission" }),
			pane("done", { status: "review" }),
			pane("idle", { status: "idle" }),
		];
		const cards = homeCards(panes, columnOf, new Set(panes.map((p) => p.id)));
		expect(ids(cards)).toEqual(["working", "asking"]);
	});

	// The board's column, not the pane's status: a /loop session between ticks
	// reads "review" on the pane but sits in Idle on the board.
	it("files a session under the column the board gives it", () => {
		const cards = homeCards(
			[pane("looping", { status: "review" })],
			() => "idle",
			new Set(["looping"]),
		);
		expect(cards).toEqual([]);
	});

	it("leaves out a closed session the board keeps in Needs you", () => {
		const cards = homeCards(
			[pane("closed", { status: "idle", odinClosedIn: "permission" })],
			() => "permission",
			new Set(),
		);
		expect(cards).toEqual([]);
	});

	it("leaves out a completed session the board keeps off", () => {
		const cards = homeCards(
			[pane("gone", { status: "permission", completed: true })],
			columnOf,
			new Set(),
		);
		expect(cards).toEqual([]);
	});

	// No sort: Needs you doesn't jump ahead of Working.
	it("keeps the order it was given", () => {
		const panes = [
			pane("a", { status: "working", odinStatusAt: 1 }),
			pane("b", { status: "permission", odinStatusAt: 5 }),
		];
		const cards = homeCards(panes, columnOf, new Set(["a", "b"]));
		expect(ids(cards)).toEqual(["a", "b"]);
	});
});

describe("homeOrder", () => {
	it("starts in the order the sessions are listed", () => {
		expect(homeOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
	});

	it("keeps a saved order, whatever order they're listed in now", () => {
		expect(homeOrder(["c", "a", "b"], ["a", "b", "c"])).toEqual([
			"c",
			"a",
			"b",
		]);
	});

	it("puts a new session at the end", () => {
		expect(homeOrder(["b", "a"], ["a", "b", "new"])).toEqual(["b", "a", "new"]);
	});

	it("drops a session that left", () => {
		expect(homeOrder(["a", "gone", "b"], ["a", "b"])).toEqual(["a", "b"]);
	});

	// Leaving drops it from the saved order, so the comeback is a new arrival.
	it("puts a session that comes back at the end", () => {
		const afterLeaving = homeOrder(["a", "b", "c"], ["b", "c"]);
		expect(homeOrder(afterLeaving, ["a", "b", "c"])).toEqual(["b", "c", "a"]);
	});
});

describe("moveCard", () => {
	it("moves a card forward onto another's place", () => {
		expect(moveCard(["a", "b", "c", "d"], "a", "c")).toEqual([
			"b",
			"c",
			"a",
			"d",
		]);
	});

	it("moves a card back onto another's place", () => {
		expect(moveCard(["a", "b", "c", "d"], "d", "b")).toEqual([
			"a",
			"d",
			"b",
			"c",
		]);
	});

	it("leaves the order alone for itself or an unknown card", () => {
		const order = ["a", "b"];
		expect(moveCard(order, "a", "a")).toBe(order);
		expect(moveCard(order, "x", "a")).toBe(order);
		expect(moveCard(order, "a", "x")).toBe(order);
	});
});

describe("homeGrid", () => {
	it("puts up to three side by side in one full-height row", () => {
		expect(homeGrid(1)).toEqual({ rows: 1, spans: [6] });
		expect(homeGrid(2)).toEqual({ rows: 1, spans: [3, 3] });
		expect(homeGrid(3)).toEqual({ rows: 1, spans: [2, 2, 2] });
	});

	it("makes 2x2 for four and three over two for five", () => {
		expect(homeGrid(4)).toEqual({ rows: 2, spans: [3, 3, 3, 3] });
		expect(homeGrid(5)).toEqual({ rows: 2, spans: [2, 2, 2, 3, 3] });
	});

	it("keeps three a row at two rows a screen from six on, so the rest scroll", () => {
		expect(homeGrid(6)).toEqual({ rows: 2, spans: [2, 2, 2, 2, 2, 2] });
		expect(homeGrid(7)).toEqual({ rows: 2, spans: [2, 2, 2, 2, 2, 2, 2] });
	});
});
