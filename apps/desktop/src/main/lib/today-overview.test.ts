import { describe, expect, it } from "bun:test";
import { parseTodayLines, todayLine } from "./today-overview";

describe("parseTodayLines", () => {
	it("reads the summary and a line per number", () => {
		const out = parseTodayLines(
			"Here you go:\nSUMMARY: Two things need you; one is due tomorrow.\n1: The login fix is done and waits for testing.\n2. The report export is still running.\n9: out of range",
			["a", "b"],
		);
		expect(out.summary).toBe("Two things need you; one is due tomorrow.");
		expect(out.lines).toEqual({
			a: "The login fix is done and waits for testing.",
			b: "The report export is still running.",
		});
	});

	it("gives nothing for an answer in another shape", () => {
		expect(parseTodayLines("Demo status", ["a"])).toEqual({
			summary: null,
			lines: {},
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
