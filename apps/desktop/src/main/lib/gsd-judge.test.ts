import { expect, test } from "bun:test";
import { GSD_ALLOW_NOTHING } from "shared/gsd-policy";
import { gsdJudgePrompt, parseGsdVerdict } from "./gsd-judge";

test("the reviewer's holds are read by command number", () => {
	expect(
		parseGsdVerdict(
			'Here: {"hold": [{"n": 2, "why": "deploys to production"}]}',
			3,
		),
	).toEqual({ 1: "deploys to production" });
	expect(parseGsdVerdict('{"hold": []}', 3)).toEqual({});
});

test("an answer that can't be read is no verdict, not a pass", () => {
	expect(parseGsdVerdict("all good", 2)).toBeNull();
	expect(parseGsdVerdict('{"ok": true}', 2)).toBeNull();
	expect(parseGsdVerdict('{"hold": [{"n": 7}]}', 2)).toBeNull();
});

test("the reviewer is told the settings as they are", () => {
	const off = gsdJudgePrompt(["gh pr merge 12"], GSD_ALLOW_NOTHING, "Done.");
	expect(off).toContain("default branch: NOT ALLOWED");
	expect(off).toContain("=== 1 ===\ngh pr merge 12");
	const on = gsdJudgePrompt(
		["gh pr merge 12"],
		{ ...GSD_ALLOW_NOTHING, merge: true },
		"Done.",
	);
	expect(on).toContain("default branch: ALLOWED");
});
