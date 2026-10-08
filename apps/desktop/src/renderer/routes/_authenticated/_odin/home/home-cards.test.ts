import { describe, expect, it } from "bun:test";
import type { Pane } from "renderer/stores/tabs/types";
import { HOME_LIMIT, homeCards, homeGrid } from "./home-cards";

const pane = (id: string, fields: Partial<Pane> = {}): Pane => ({
	id,
	tabId: `tab-${id}`,
	type: "terminal",
	name: id,
	...fields,
});

const ids = (result: ReturnType<typeof homeCards>) =>
	result.cards.map((card) => card.pane.id);

describe("homeCards", () => {
	it("keeps Working and Needs you, and leaves Done and Idle out", () => {
		const result = homeCards(
			[
				pane("working", { status: "working" }),
				pane("asking", { status: "permission" }),
				pane("done", { status: "review" }),
				pane("parked", { status: "idle", odinParked: true }),
				pane("dead", { status: "working" }),
			],
			new Set(["working", "asking", "done", "parked"]),
		);
		expect(ids(result).sort()).toEqual(["asking", "working"]);
	});

	// The board's column, not the raw status: an alive session nobody set a
	// status on wants a look, and a failed one needs you.
	it("files a session under the column the board gives it", () => {
		const result = homeCards(
			[pane("unset", { status: "idle" }), pane("failed", { status: "failed" })],
			new Set(["unset", "failed"]),
		);
		expect(result.cards.map((card) => card.column)).toEqual([
			"permission",
			"permission",
		]);
	});

	it("keeps a session closed for idling in the column it was closed from", () => {
		const result = homeCards(
			[pane("closed", { status: "idle", odinClosedIn: "permission" })],
			new Set(),
		);
		expect(result.cards).toEqual([
			{ pane: expect.objectContaining({ id: "closed" }), column: "permission" },
		]);
	});

	it("puts Needs you first, then Working, newest first within each", () => {
		const result = homeCards(
			[
				pane("old-working", { status: "working", odinStatusAt: 1 }),
				pane("new-working", { status: "working", odinStatusAt: 5 }),
				pane("old-asking", { status: "permission", odinStatusAt: 2 }),
				pane("new-asking", { status: "permission", odinStatusAt: 4 }),
			],
			new Set(["old-working", "new-working", "old-asking", "new-asking"]),
		);
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
		const result = homeCards(panes, new Set(panes.map((p) => p.id)));
		expect(result.cards).toHaveLength(HOME_LIMIT);
		expect(result.more).toBe(3);
		expect(ids(result)[0]).toBe("p8");
	});

	it("has nothing more when everything fits", () => {
		expect(homeCards([], new Set()).more).toBe(0);
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
