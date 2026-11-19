import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openingAsk, parseTodayLines, todayLine } from "./today-overview";

describe("parseTodayLines", () => {
	it("reads the summary and the sessions grouped into tasks", () => {
		const out = parseTodayLines(
			[
				"Here you go:",
				"SUMMARY: Sign-in needs you first; the export is due tomorrow.",
				"TASK 1, 3: Fix sign-in | New users can't sign in, so they can't start. | The emailed code expires too early, so new users never reach their first project. Once fixed, they can finish sign-in. | The fix is written. | Only a test. | You: test it on staging.",
				"- **TASK 2**: Report export | Lets teams download their numbers. | - | Running, about half left.",
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
				explain:
					"The emailed code expires too early, so new users never reach their first project. Once fixed, they can finish sign-in.",
				line: "The fix is written.",
				left: "Only a test.",
				next: "You: test it on staging.",
			},
			{
				keys: ["b"],
				name: "Report export",
				about: "Lets teams download their numbers.",
				explain: null,
				line: "Running, about half left.",
				left: null,
				next: null,
			},
		]);
	});

	it("puts a session in one task only, and keeps a task with only a name", () => {
		const out = parseTodayLines(
			"TASK 1,2: First\nTASK 2: Second | about it\nTASK 1: Third",
			["a", "b"],
		);
		expect(out.tasks).toEqual([
			{
				keys: ["a", "b"],
				name: "First",
				about: null,
				explain: null,
				line: null,
				left: null,
				next: null,
			},
		]);
	});

	it("keeps a summary the model wrapped onto the next line", () => {
		const out = parseTodayLines(
			"SUMMARY: Start with the sign-in fix,\nthen merge the export.\n\nNot part of it.\nTASK 1: Fix sign-in",
			["a"],
		);
		expect(out.summary).toBe(
			"Start with the sign-in fix, then merge the export.",
		);
		expect(out.tasks.map((t) => t.name)).toEqual(["Fix sign-in"]);
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
					from: "Jira: Login broken",
				},
				0,
				{
					goal: "Fix the\nlogin bug",
					done: "Found the expired code",
					status: null,
					next: "Review it",
				},
				"Users say | the code fails",
			),
		).toBe(
			"1 | Needs you | 2026-11-16 | High | - | Jira: Login broken | Fix / login | Users say / the code fails | Fix the login bug | Found the expired code | - | Review it",
		);
	});
});

describe("openingAsk", () => {
	it("reads the opening request from the start of the transcript", async () => {
		const root = mkdtempSync(join(tmpdir(), "today-ask-"));
		mkdirSync(join(root, "-Users-me-dev-app"));
		const line = (text: string) =>
			JSON.stringify({
				type: "user",
				message: { role: "user", content: text },
			});
		writeFileSync(
			join(root, "-Users-me-dev-app", "s1.jsonl"),
			`${line("Team leads want to download monthly numbers as CSV")}\n${line("also add totals")}\n`,
		);
		expect(await openingAsk("s1", root)).toContain("download monthly numbers");
		expect(await openingAsk("missing", root)).toBeNull();
	});
});
