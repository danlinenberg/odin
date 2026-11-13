import { expect, test } from "bun:test";
import { mergeHits, titleMatches } from "./search";

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

test("a board session the Mac's search left out stays in the results", () => {
	const hit = (
		sessionId: string,
		paneId: string | null,
		updatedAt: number,
	) => ({
		sessionId,
		paneId,
		title: sessionId,
		snippet: paneId === "a" ? "from the conversation" : "",
		person: null,
		updatedAt,
	});
	// "a" is in both: the Mac's row, with its snippet, stands for it.
	const merged = mergeHits(
		[hit("s-a", "a", 5), hit("s-old", null, 1)],
		[hit("a", "a", 4), hit("new", "new", 9)],
	);
	expect(merged.map((h) => h.sessionId)).toEqual(["new", "s-a", "s-old"]);
	expect(merged[1].snippet).toBe("from the conversation");
});
