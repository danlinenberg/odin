import { describe, expect, it } from "bun:test";
import {
	BRANCH,
	commentTarget,
	patchRows,
	type ReviewComment,
	reviewMessage,
} from "./diff-review";

const PATCH = [
	"diff --git a/app.py b/app.py",
	"--- a/app.py",
	"+++ b/app.py",
	"@@ -10,4 +10,4 @@ def main():",
	" a = 1",
	"-b = 2",
	"+b = 3",
	"+c = 4",
	" d = 5",
	"\\ No newline at end of file",
].join("\n");

describe("patchRows", () => {
	it("numbers each line on the sides it exists on, skipping the header", () => {
		expect(patchRows(PATCH)).toEqual([
			{ kind: " ", old: 10, new: 10, text: "a = 1" },
			{ kind: "-", old: 11, text: "b = 2" },
			{ kind: "+", new: 11, text: "b = 3" },
			{ kind: "+", new: 12, text: "c = 4" },
			{ kind: " ", old: 12, new: 13, text: "d = 5" },
		]);
	});
});

describe("commentTarget", () => {
	it("quotes the added lines and names them by their new numbers", () => {
		expect(
			commentTarget(PATCH, "app.py", { start: 11, end: 12, side: "additions" }),
		).toEqual({
			side: "additions",
			lineNumber: 12,
			location: "app.py:11-12",
			code: ["+ b = 3", "+ c = 4"],
		});
	});

	it("spans a drag from a removed line into the added ones", () => {
		const target = commentTarget(PATCH, "app.py", {
			start: 11,
			side: "deletions",
			end: 11,
			endSide: "additions",
		});
		expect(target.location).toBe("app.py:11");
		expect(target.code).toEqual(["- b = 2", "+ b = 3"]);
	});

	it("anchors under the lowest line when the drag goes up", () => {
		const target = commentTarget(PATCH, "app.py", {
			start: 13,
			end: 10,
			side: "additions",
		});
		expect(target).toMatchObject({ side: "additions", lineNumber: 13 });
		expect(target.location).toBe("app.py:10-13");
	});

	it("names a removed-only range by its old numbers", () => {
		expect(
			commentTarget(PATCH, "app.py", { start: 11, end: 11, side: "deletions" })
				.location,
		).toBe("app.py (removed, old lines 11)");
	});
});

describe("reviewMessage", () => {
	const comment: ReviewComment = {
		id: "1",
		pr: null,
		path: "app.py",
		side: "additions",
		lineNumber: 11,
		location: "app.py:11",
		code: ["+ b = 3"],
		text: "Keep b at 2.\nIt is read by c.",
	};

	it("numbers each comment under its location and quoted code", () => {
		expect(reviewMessage([comment], null)).toBe(
			[
				"Review comments on the working tree diff. Fix each one, or tell me why not:",
				"1. app.py:11\n   | + b = 3\n   Keep b at 2.\n   It is read by c.",
			].join("\n\n"),
		);
	});

	it("names the PR the diff came from", () => {
		expect(
			reviewMessage([comment], "https://github.com/o/r/pull/7").split("\n")[0],
		).toBe(
			"Review comments on the diff of https://github.com/o/r/pull/7. Fix each one, or tell me why not:",
		);
	});

	it("names the branch diff", () => {
		expect(reviewMessage([comment], BRANCH).split("\n")[0]).toBe(
			"Review comments on this branch's diff against its base branch. Fix each one, or tell me why not:",
		);
	});
});
