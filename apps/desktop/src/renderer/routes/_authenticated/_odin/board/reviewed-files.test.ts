import { describe, expect, test } from "bun:test";
import {
	isReviewed,
	markKey,
	nextUnreviewed,
	patchMark,
	pruneMarks,
	reviewedCount,
	toggleReviewed,
} from "./reviewed-files";

const a = { path: "src/a.ts", patch: "diff --git a/src/a.ts\n+one\n" };
const b = { path: "src/b.ts", patch: "diff --git a/src/b.ts\n+two\n" };
const c = { path: "src/c.ts", patch: "diff --git a/src/c.ts\n+three\n" };

describe("reviewed files in the diff view", () => {
	test("a tick remembers the patch; a changed patch clears it", () => {
		const marks = toggleReviewed({}, null, a);
		expect(isReviewed(marks, null, a)).toBe(true);
		const pushed = { ...a, patch: `${a.patch}+more\n` };
		expect(isReviewed(marks, null, pushed)).toBe(false);
		// Ticking the changed file again replaces the old mark.
		const again = toggleReviewed(marks, null, pushed);
		expect(isReviewed(again, null, pushed)).toBe(true);
		expect(Object.keys(again)).toEqual([markKey(null, a.path)]);
	});

	test("a second tick unticks", () => {
		const marks = toggleReviewed(toggleReviewed({}, null, a), null, a);
		expect(marks).toEqual({});
	});

	test("marks are per diff: a PR's tick is not the working tree's", () => {
		const marks = toggleReviewed({}, "https://github.com/o/r/pull/1", a);
		expect(isReviewed(marks, null, a)).toBe(false);
		expect(reviewedCount(marks, "https://github.com/o/r/pull/1", [a, b])).toBe(
			1,
		);
		expect(reviewedCount(marks, null, [a, b])).toBe(0);
	});

	test("pruning keeps only this diff's current files, other diffs untouched", () => {
		let marks = toggleReviewed({}, null, a);
		marks = toggleReviewed(marks, null, b);
		marks = toggleReviewed(marks, "branch", c);
		// b changed, a is gone from the diff, c belongs to the branch diff.
		const pruned = pruneMarks(marks, null, [{ ...b, patch: "diff\n+new\n" }]);
		expect(Object.keys(pruned)).toEqual([markKey("branch", c.path)]);
	});

	test("the next unreviewed file comes after the current one, wrapping round", () => {
		let marks = toggleReviewed({}, null, b);
		expect(nextUnreviewed(marks, null, [a, b, c], 0)).toBe(2);
		expect(nextUnreviewed(marks, null, [a, b, c], 2)).toBe(0);
		marks = toggleReviewed(toggleReviewed(marks, null, a), null, c);
		expect(nextUnreviewed(marks, null, [a, b, c], 1)).toBe(-1);
	});

	test("the mark is short and stable", () => {
		expect(patchMark(a.patch)).toBe(patchMark(a.patch));
		expect(patchMark(a.patch)).not.toBe(patchMark(b.patch));
		expect(patchMark(a.patch).length).toBeLessThan(20);
	});
});
