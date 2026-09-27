import { expect, test } from "bun:test";
import { parseRanking } from "./next-in-line-rank";

test("parseRanking keeps the model's order and drops what it got wrong", () => {
	const keys = ["a", "b", "c", "d", "e"];
	// Chatty wrapper, an invented line, a duplicate, a key instead of a number;
	// "d" left out is left out; a line in both lists is hidden.
	const text =
		'Sure:\n```json\n{"order": [3, 9, 1, 3, "b", 2, 5, 0], "hide": [5, 7]}\n```';
	expect(parseRanking(text, keys)).toEqual({
		keys: ["c", "a", "b"],
		hidden: ["e"],
	});
});

test("parseRanking returns nothing on garbage", () => {
	const none = { keys: [], hidden: [] };
	expect(parseRanking("no idea", ["a", "b"])).toEqual(none);
	expect(parseRanking("{not json}", ["a", "b"])).toEqual(none);
	expect(parseRanking("[1, 2]", ["a", "b"])).toEqual(none);
});
