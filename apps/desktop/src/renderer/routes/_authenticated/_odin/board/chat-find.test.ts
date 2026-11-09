import { describe, expect, test } from "bun:test";
import { firstFrom, matchSpans } from "./chat-find";

describe("matchSpans", () => {
	test("finds every match, ignoring case", () => {
		expect(matchSpans("Odin and odin and ODIN", "odin")).toEqual([
			[0, 4],
			[9, 13],
			[18, 22],
		]);
	});

	test("does not count overlapping matches twice", () => {
		expect(matchSpans("aaaa", "aa")).toEqual([
			[0, 2],
			[2, 4],
		]);
	});

	test("an empty query or no match finds nothing", () => {
		expect(matchSpans("hello", "")).toEqual([]);
		expect(matchSpans("hello", "bye")).toEqual([]);
	});

	test("text whose lower case changes length finds nothing, not wrong spans", () => {
		expect(matchSpans("İstanbul x", "x")).toEqual([]);
	});
});

describe("firstFrom", () => {
	test("starts at the first match at or below where you read", () => {
		expect(firstFrom([10, 200, 400], 150)).toBe(1);
		expect(firstFrom([10, 200, 400], 200)).toBe(1);
	});

	test("wraps to the first match when every match is above", () => {
		expect(firstFrom([10, 20], 500)).toBe(0);
		expect(firstFrom([], 0)).toBe(0);
	});
});
