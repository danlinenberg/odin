import { describe, expect, it } from "bun:test";
import { boardTags, normalizeTag } from "./odin-tags";

describe("boardTags", () => {
	it("keeps the list and drops what the old vocabulary left behind", () => {
		expect(boardTags(["odin", "perf", "chore", "api"])).toEqual(["chore"]);
		expect(boardTags(undefined)).toEqual([]);
	});

	it("keeps the custom tags you added", () => {
		expect(boardTags(["perf", "client-x"], ["client-x"])).toEqual(["client-x"]);
	});
});

describe("normalizeTag", () => {
	it("strips the hash, spaces and punctuation", () => {
		expect(normalizeTag("  #Client X! ")).toEqual("client-x");
		expect(normalizeTag("##")).toEqual("");
	});
});
