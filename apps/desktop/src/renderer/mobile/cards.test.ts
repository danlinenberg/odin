import { expect, test } from "bun:test";
import { boardSections } from "./cards";

test("a column lists starred first, then by last activity", () => {
	const row = (paneId: string, statusAt: number | null, starred = false) =>
		({ paneId, title: paneId, column: "idle", statusAt, starred }) as never;
	const idle = boardSections([
		row("old", 1),
		row("new", 3),
		row("never", null),
		row("star", 0, true),
	]).find((s) => s.key === "idle");
	expect(idle?.rows.map((r) => r.paneId)).toEqual([
		"star",
		"new",
		"old",
		"never",
	]);
});
