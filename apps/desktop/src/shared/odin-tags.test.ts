import { describe, expect, it } from "bun:test";
import { boardTags, withOdinTag } from "./odin-tags";

const ODIN = "/Users/dan/dev/private/odin";

describe("withOdinTag", () => {
	it("tags the repo itself and its worktrees", () => {
		expect(withOdinTag(undefined, ODIN, ODIN)).toEqual(["odin"]);
		expect(withOdinTag(["bugs"], `${ODIN}/.worktrees/x`, ODIN)).toEqual([
			"bugs",
			"odin",
		]);
	});

	it("leaves other repos alone", () => {
		expect(withOdinTag(["bugs"], "/Users/dan/dev/imagen", ODIN)).toEqual([
			"bugs",
		]);
		// A sibling checkout whose path merely starts with the same characters.
		expect(withOdinTag(undefined, `${ODIN}-old`, ODIN)).toBeUndefined();
		expect(withOdinTag(undefined, ODIN, null)).toBeUndefined();
	});

	it("does not duplicate an explicit tag", () => {
		expect(withOdinTag(["odin"], ODIN, ODIN)).toEqual(["odin"]);
	});
});

describe("boardTags", () => {
	it("keeps the list and drops what the old vocabulary left behind", () => {
		expect(boardTags(["odin", "perf", "chore", "api"])).toEqual([
			"odin",
			"chore",
		]);
		expect(boardTags(undefined)).toEqual([]);
	});
});
