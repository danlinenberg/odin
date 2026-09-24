import { expect, test } from "bun:test";
import { parseRanking } from "./next-in-line-rank";

test("parseRanking keeps the model's order and drops what it got wrong", () => {
	const keys = ["a", "b", "c", "d"];
	// Chatty wrapper, an invented key, a duplicate; "d" left out is left out.
	const text = 'Sure:\n```json\n["c", "x", "a", "c", "b"]\n```';
	expect(parseRanking(text, keys)).toEqual(["c", "a", "b"]);
});

test("parseRanking returns nothing on garbage", () => {
	expect(parseRanking("no idea", ["a", "b"])).toEqual([]);
	expect(parseRanking("[not json]", ["a", "b"])).toEqual([]);
});
