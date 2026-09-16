import { describe, expect, test } from "bun:test";
import { firstPrompt } from "./claude-sessions";
import {
	activeIntervals,
	computeWorkload,
	mergeIntervals,
	type SessionWork,
	scanTranscript,
	totalMs,
	weekStart,
} from "./workload";

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** 2026-09-14 is a Monday. */
const MON = new Date(2026, 8, 14, 9, 0, 0).getTime();

function session(over: Partial<SessionWork> = {}): SessionWork {
	const intervals = over.intervals ?? [[MON, MON + HOUR]];
	return {
		sessionId: "s1",
		project: "p",
		person: null,
		source: null,
		cwd: null,
		title: null,
		entries: 2,
		intervals,
		activeMs: over.activeMs ?? totalMs(intervals),
		startedAt: over.startedAt ?? intervals[0]?.[0] ?? MON,
		endedAt: over.endedAt ?? intervals.at(-1)?.[1] ?? MON,
		...over,
	};
}

describe("activeIntervals", () => {
	test("welds entries closer than the idle gap into one span", () => {
		expect(activeIntervals([0, MINUTE, 2 * MINUTE], 5 * MINUTE)).toEqual([
			[0, 2 * MINUTE],
		]);
	});

	test("a long silence ends the span rather than being counted", () => {
		const out = activeIntervals([0, MINUTE, HOUR, HOUR + MINUTE], 5 * MINUTE);
		expect(out).toEqual([
			[0, MINUTE],
			[HOUR, HOUR + MINUTE],
		]);
		expect(totalMs(out)).toBe(2 * MINUTE);
	});

	test("a lone entry has no duration", () => {
		expect(activeIntervals([5])).toEqual([]);
	});

	test("out-of-order timestamps can't produce a negative span", () => {
		expect(activeIntervals([MINUTE, 0], 5 * MINUTE)).toEqual([[0, MINUTE]]);
	});
});

describe("mergeIntervals", () => {
	test("overlapping spans count as one stretch of your time", () => {
		expect(
			mergeIntervals([
				[0, 2 * HOUR],
				[HOUR, 3 * HOUR],
			]),
		).toEqual([[0, 3 * HOUR]]);
	});

	test("separate spans stay separate", () => {
		expect(
			mergeIntervals([
				[4 * HOUR, 5 * HOUR],
				[0, HOUR],
			]),
		).toEqual([
			[0, HOUR],
			[4 * HOUR, 5 * HOUR],
		]);
	});
});

describe("scanTranscript", () => {
	const line = (at: string, cwd: string) =>
		JSON.stringify({ type: "user", timestamp: at, cwd });

	test("reads times and the busiest cwd out of raw jsonl", () => {
		const jsonl = [
			line("2026-09-14T09:00:00.000Z", "/repo/a"),
			line("2026-09-14T09:02:00.000Z", "/repo/b"),
			line("2026-09-14T09:03:00.000Z", "/repo/b"),
		].join("\n");
		const scan = scanTranscript(jsonl);
		expect(scan?.activeMs).toBe(3 * MINUTE);
		expect(scan?.cwd).toBe("/repo/b");
		expect(scan?.entries).toBe(3);
	});

	test("a transcript with no timestamps is skipped, not counted as zero", () => {
		expect(scanTranscript('{"type":"summary"}')).toBeNull();
	});
});

describe("computeWorkload", () => {
	test("parallel agents bill more hours than they cost you", () => {
		const out = computeWorkload(
			[
				session({ sessionId: "a", intervals: [[MON, MON + 2 * HOUR]] }),
				session({ sessionId: "b", intervals: [[MON, MON + 2 * HOUR]] }),
			],
			{ now: MON },
		);
		expect(out.agentHours).toBe(4);
		expect(out.yourHours).toBe(2);
		expect(out.leverage).toBe(2);
	});

	test("a quiet week inside the record is kept, so a gap reads as a gap", () => {
		const twoWeeksBack = MON - 14 * 86_400_000;
		const out = computeWorkload(
			[
				session({
					sessionId: "old",
					intervals: [[twoWeeksBack, twoWeeksBack + HOUR]],
				}),
				session({ sessionId: "new" }),
			],
			{ now: MON, weeks: 6 },
		);
		expect(out.weeks.map((week) => week.agentHours)).toEqual([1, 0, 1]);
		expect(out.weeks.at(-1)?.start).toBe(weekStart(MON));
	});

	test("weeks before the record starts are dropped, not drawn as zero", () => {
		// Six weeks were asked for; only one has any transcript behind it, and
		// five empty columns would read as five quiet weeks that never happened.
		const out = computeWorkload([session()], { now: MON, weeks: 6 });
		expect(out.weeks).toHaveLength(1);
		expect(out.weeks[0]?.start).toBe(weekStart(MON));
	});

	test("the longest tasks come out first, with their own titles", () => {
		const out = computeWorkload(
			[
				session({ sessionId: "short", intervals: [[MON, MON + HOUR]] }),
				session({
					sessionId: "long",
					title: "fix the board scanner",
					intervals: [[MON, MON + 3 * HOUR]],
				}),
			],
			{ now: MON },
		);
		expect(out.longest[0]?.sessionId).toBe("long");
		expect(out.longest[0]?.title).toBe("fix the board scanner");
		expect(out.longest[0]?.hours).toBe(3);
		// No title in the transcript falls back to the id, never to blank.
		expect(out.longest[1]?.title).toBe("session short");
	});

	test("hours are credited to whoever asked", () => {
		const out = computeWorkload(
			[
				session({
					sessionId: "a",
					person: "Ofek",
					intervals: [[MON, MON + HOUR]],
				}),
				session({
					sessionId: "b",
					person: "Ofek",
					intervals: [[MON + 2 * HOUR, MON + 3 * HOUR]],
				}),
				session({
					sessionId: "c",
					person: "Lior",
					intervals: [[MON + 4 * HOUR, MON + 4.5 * HOUR]],
				}),
			],
			{ now: MON },
		);
		expect(out.byPerson).toEqual([
			{ person: "Ofek", hours: 2, sessions: 2 },
			{ person: "Lior", hours: 0.5, sessions: 1 },
		]);
		expect(out.attributed).toBe(3);
	});

	test("an overnight run lands on both days", () => {
		const night = new Date(2026, 8, 14, 23, 30, 0).getTime();
		const out = computeWorkload(
			[session({ intervals: [[night, night + HOUR]] })],
			{ now: night },
		);
		expect(out.busiestDay?.hours).toBe(0.5);
	});

	test("time is placed at the hour of day it happened", () => {
		const out = computeWorkload([session()], { now: MON });
		// MON is 09:00 local, one hour long.
		expect(out.byHour[9]).toBe(60);
		expect(out.byHour[10]).toBe(0);
	});

	test("nothing recorded divides by nothing", () => {
		const out = computeWorkload([], { now: MON });
		expect(out.leverage).toBeNull();
		expect(out.busiestDay).toBeNull();
		expect(out.since).toBeNull();
	});
});

describe("firstPrompt", () => {
	const typed = (text: string) =>
		JSON.stringify({
			type: "user",
			promptSource: "typed",
			message: { content: text },
		});

	test("a Slack task is titled by the ask, not by Odin's framing", () => {
		expect(
			firstPrompt(
				typed(
					[
						"Task: @Dan can you help? :pray:",
						"",
						"This task comes from a Slack thread: https://x.slack.com/archives/C1/p17",
						"",
						"What was posted there:",
						"@Dan can you help? :pray:",
						"Exports are being charged twice.",
						"",
						"PHASE 1 — INGEST (do this first, before anything else):",
						"- Read the ENTIRE thread.",
						"",
						"Work in the current workspace. Investigate.",
					].join("\n"),
				),
			),
		).toBe("@Dan can you help? :pray: Exports are being charged twice.");
	});

	test("a plain prompt is its own title", () => {
		expect(firstPrompt(typed("fix the board scanner"))).toBe(
			"fix the board scanner",
		);
	});

	test("a session with nothing typed has no title to give", () => {
		expect(firstPrompt('{"type":"summary"}')).toBeNull();
	});
});
