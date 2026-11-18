import { describe, expect, it } from "bun:test";
import { parseTodayLines, todayLine } from "./today-overview";

describe("parseTodayLines", () => {
	it("reads the summary and the sessions grouped into tasks", () => {
		const out = parseTodayLines(
			[
				"Here you go:",
				"SUMMARY: Sign-in needs you first; the export is due tomorrow.",
				"TASK 1, 3: Fix sign-in | New users can't sign in, so they can't start. | Done, only waits for testing.",
				"- **TASK 2**: Report export | Lets teams download their numbers. | Running, about half left.",
				"TASK 9: Out of range | - | -",
			].join("\n"),
			["a", "b", "c"],
		);
		expect(out.summary).toBe(
			"Sign-in needs you first; the export is due tomorrow.",
		);
		expect(out.tasks).toEqual([
			{
				keys: ["a", "c"],
				name: "Fix sign-in",
				about: "New users can't sign in, so they can't start.",
				line: "Done, only waits for testing.",
			},
			{
				keys: ["b"],
				name: "Report export",
				about: "Lets teams download their numbers.",
				line: "Running, about half left.",
			},
		]);
	});

	it("puts a session in one task only, and keeps a task with only a name", () => {
		const out = parseTodayLines(
			"TASK 1,2: First\nTASK 2: Second | about it\nTASK 1: Third",
			["a", "b"],
		);
		expect(out.tasks).toEqual([
			{ keys: ["a", "b"], name: "First", about: null, line: null },
		]);
	});

	it("gives nothing for an answer in another shape", () => {
		expect(parseTodayLines("Demo status\n1: a line", ["a"])).toEqual({
			summary: null,
			tasks: [],
		});
	});
});

describe("todayLine", () => {
	it("puts one task on one pipe-separated line", () => {
		expect(
			todayLine(
				{
					key: "p1",
					sessionId: "s1",
					title: "Fix | login",
					group: "Needs you",
					due: "2026-11-16",
					priority: "High",
					waitingOn: null,
				},
				0,
				{ goal: "Fix the\nlogin bug", status: null, next: "Review it" },
			),
		).toBe(
			"1 | Needs you | 2026-11-16 | High | - | Fix / login | Fix the login bug | - | Review it",
		);
	});
});
