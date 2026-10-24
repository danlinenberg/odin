import { expect, test } from "bun:test";
import { titleMatches } from "./search";

test("board titles match every typed word, newest first", () => {
	const row = (paneId: string, title: string, statusAt: number) => ({
		paneId,
		title,
		contact: paneId === "b" ? "Maya" : null,
		repo: "odin",
		statusAt,
		column: "idle" as const,
	});
	const sessions = [
		row("a", "Phone search is slow", 1),
		row("b", "Fix the search box", 2),
		row("c", "Dictation misses words", 3),
	];
	expect(titleMatches(sessions, "search").map((h) => h.paneId)).toEqual([
		"b",
		"a",
	]);
	expect(titleMatches(sessions, "SEARCH maya").map((h) => h.paneId)).toEqual([
		"b",
	]);
	expect(titleMatches(sessions, "kangaroo")).toEqual([]);
});
