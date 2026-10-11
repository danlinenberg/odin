import { describe, expect, it } from "bun:test";
import { nextSelection, visibleSelection } from "./selection";

const rows = ["a", "b", "c", "d", "e"];

describe("nextSelection", () => {
	it("a click ticks and unticks one row", () => {
		const one = nextSelection(new Set(), rows, "b", false, null);
		expect([...one]).toEqual(["b"]);
		expect([...nextSelection(one, rows, "b", false, "b")]).toEqual([]);
	});

	it("shift-click ticks every row between the anchor and the click", () => {
		const next = nextSelection(new Set(["b"]), rows, "d", true, "b");
		expect([...next].sort()).toEqual(["b", "c", "d"]);
	});

	it("shift-click upwards works, and unticks a range when the click unticks", () => {
		const all = new Set(rows);
		const next = nextSelection(all, rows, "b", true, "d");
		expect([...next].sort()).toEqual(["a", "e"]);
	});

	it("an anchor no longer on screen falls back to a single tick", () => {
		const next = nextSelection(new Set(), rows, "c", true, "gone");
		expect([...next]).toEqual(["c"]);
	});
});

describe("visibleSelection", () => {
	it("keeps only ticked rows still on screen, in screen order", () => {
		expect(visibleSelection(new Set(["d", "gone", "a"]), rows)).toEqual([
			"a",
			"d",
		]);
	});
});
