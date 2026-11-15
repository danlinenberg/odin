import { expect, test } from "bun:test";
import { prSummary } from "./brief-card";

test("prSummary counts PRs by state", () => {
	expect(prSummary(["OPEN", "MERGED", "MERGED", undefined])).toBe(
		"4 PRs · 2 open · 2 merged",
	);
	expect(prSummary(["CLOSED"])).toBe("1 PR · 1 closed");
});
