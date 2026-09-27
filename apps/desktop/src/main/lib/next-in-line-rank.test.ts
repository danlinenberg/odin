import { expect, test } from "bun:test";
import { parseRanking } from "./next-in-line-rank";

test("parseRanking keeps the model's order and drops what it got wrong", () => {
	const keys = ["a", "b", "c", "d", "e"];
	// Chatty wrapper, an invented key, a duplicate; "d" left out is left out;
	// a key in both lists is hidden.
	const text =
		'Sure:\n```json\n{"order": ["c", "x", "a", "c", "b", "e"], "hide": ["e", "y"]}\n```';
	expect(parseRanking(text, keys)).toEqual({
		keys: ["c", "a", "b"],
		hidden: ["e"],
	});
});

test("parseRanking returns nothing on garbage", () => {
	const none = { keys: [], hidden: [] };
	expect(parseRanking("no idea", ["a", "b"])).toEqual(none);
	expect(parseRanking("{not json}", ["a", "b"])).toEqual(none);
	expect(parseRanking('["a", "b"]', ["a", "b"])).toEqual(none);
});
