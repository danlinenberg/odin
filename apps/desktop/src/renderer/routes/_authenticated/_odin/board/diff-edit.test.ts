import { describe, expect, it } from "bun:test";
import { canEditDiffFile } from "./diff-edit";
import { BRANCH } from "./diff-review";

const edited = {
	binary: false,
	patch:
		"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
};

describe("canEditDiffFile", () => {
	it("edits a working-tree change", () => {
		expect(canEditDiffFile(null, "uncommitted changes", edited)).toBe(true);
		expect(canEditDiffFile(null, "since review", edited)).toBe(true);
	});

	it("keeps history read-only", () => {
		expect(canEditDiffFile(null, "last commit", edited)).toBe(false);
		expect(canEditDiffFile(BRANCH, "main vs b", edited)).toBe(false);
		expect(
			canEditDiffFile("https://github.com/acme/app/pull/1", "x", edited),
		).toBe(false);
	});

	it("has nothing to edit in a deleted or binary file", () => {
		const deleted = {
			binary: false,
			patch:
				"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
		};
		expect(canEditDiffFile(null, "uncommitted changes", deleted)).toBe(false);
		expect(
			canEditDiffFile(null, "uncommitted changes", { ...edited, binary: true }),
		).toBe(false);
	});
});
