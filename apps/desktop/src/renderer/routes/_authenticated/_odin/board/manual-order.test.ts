import { describe, expect, test } from "bun:test";
import { applyManualOrder, movedOrder } from "./manual-order";

const rows = (...keys: string[]) => keys.map((key) => ({ key }));
const keys = (items: { key: string }[]) => items.map((item) => item.key);

describe("applyManualOrder", () => {
	test("no saved order keeps the column's order", () => {
		expect(keys(applyManualOrder(rows("a", "b", "c"), []))).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	test("follows the saved order, new tasks last in their own order", () => {
		expect(
			keys(
				applyManualOrder(rows("new1", "a", "b", "new2", "c"), ["c", "a", "b"]),
			),
		).toEqual(["c", "a", "b", "new1", "new2"]);
	});
});

describe("movedOrder", () => {
	const known = new Set(["a", "b", "c", "d", "t"]);

	test("dragging down puts the card where it was dropped", () => {
		expect(movedOrder(["a", "b", "c"], [], "a", "c", known)).toEqual([
			"b",
			"c",
			"a",
		]);
	});

	test("dragging up", () => {
		expect(movedOrder(["a", "b", "c"], [], "c", "a", known)).toEqual([
			"c",
			"a",
			"b",
		]);
	});

	test("keeps saved keys the drag didn't see, drops ones no longer waiting", () => {
		expect(
			movedOrder(["a", "b"], ["t", "gone", "b", "a"], "b", "a", known),
		).toEqual(["b", "a", "t"]);
	});
});
