import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstPrompt, repoOfDir } from "./claude-sessions";
import {
	activeIntervals,
	computeWorkload,
	humanIntervals,
	mergeIntervals,
	openingLine,
	repoForDirs,
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
		dirs: [],
		opening: null,
		repo: null,
		title: null,
		prs: [],
		prAt: [],
		yours: [],
		subagents: [],
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

	test("names the session by its latest ai-title and finds the PRs it opened", () => {
		const jsonl = [
			line("2026-09-14T09:00:00.000Z", "/repo/a"),
			JSON.stringify({ type: "ai-title", aiTitle: 'First "guess"' }),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-09-14T09:01:00.000Z",
				message: {
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Bash",
							input: { command: "gh pr create --fill" },
						},
						{
							type: "tool_use",
							id: "t2",
							name: "Bash",
							input: { command: "gh pr view 9" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				timestamp: "2026-09-14T09:02:00.000Z",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: "https://github.com/o/r/pull/7\n",
						},
						{
							type: "tool_result",
							tool_use_id: "t2",
							content: "https://github.com/o/r/pull/9",
						},
					],
				},
			}),
			JSON.stringify({ type: "ai-title", aiTitle: "Fix the scanner" }),
		].join("\n");
		const scan = scanTranscript(jsonl);
		expect(scan?.title).toBe("Fix the scanner");
		expect(scan?.prs).toEqual(["https://github.com/o/r/pull/7"]);
	});

	test("a transcript with no timestamps is skipped, not counted as zero", () => {
		expect(scanTranscript('{"type":"summary"}')).toBeNull();
	});
});

describe("computeWorkload", () => {
	test("agent work nets out your time, adds subagents; leverage divides by you", () => {
		const you: [number, number] = [MON + HOUR, MON + 1.5 * HOUR];
		const out = computeWorkload(
			[
				session({
					sessionId: "a",
					intervals: [[MON, MON + 2 * HOUR]],
					yours: [you],
				}),
				session({
					sessionId: "b",
					intervals: [[MON, MON + 2 * HOUR]],
					yours: [you],
					subagents: [[MON, MON + HOUR]],
				}),
			],
			{ now: MON },
		);
		// (2 - 0.5) + (2 - 0.5) + 1 subagent hour.
		expect(out.agentHours).toBe(4);
		// The same half hour of yours, counted once.
		expect(out.yourHours).toBe(0.5);
		expect(out.leverage).toBe(8);
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

	test("each week recaps every session, biggest first", () => {
		const out = computeWorkload(
			[
				session({ sessionId: "short", intervals: [[MON, MON + HOUR]] }),
				session({
					sessionId: "long",
					title: "fix the board scanner",
					intervals: [[MON, MON + 3 * HOUR]],
				}),
				session({ sessionId: "peek", intervals: [[MON, MON + MINUTE]] }),
				session({
					sessionId: "pr",
					intervals: [[MON, MON + MINUTE]],
					prs: ["https://github.com/o/r/pull/1"],
					prAt: [null],
				}),
				session({
					sessionId: "last",
					intervals: [[MON - 7 * 24 * HOUR, MON - 6 * 24 * HOUR]],
				}),
			],
			{ now: MON },
		);
		expect(out.recap.map((week) => week.start)).toEqual([
			weekStart(MON - 7 * 24 * HOUR),
			weekStart(MON),
		]);
		const week = out.recap[1];
		expect(week?.sessions).toBe(4);
		expect(week?.prs).toBe(1);
		expect(week?.tasks.map((task) => task.sessionId)).toEqual([
			"long",
			"short",
			"peek",
			"pr",
		]);
		expect(week?.tasks[0]?.title).toBe("fix the board scanner");
		// No title in the transcript falls back to the id, never to blank.
		expect(week?.tasks[1]?.title).toBe("session short");
	});

	test("a session running across weeks shows in each, with that week's share", () => {
		const lastWeek = MON - 7 * 24 * HOUR;
		const out = computeWorkload(
			[
				session({
					sessionId: "long",
					intervals: [
						[lastWeek, lastWeek + 3 * HOUR],
						[MON, MON + HOUR],
					],
					prs: [
						"https://github.com/o/r/pull/1",
						"https://github.com/o/r/pull/2",
					],
					prAt: [lastWeek + HOUR, MON + HOUR / 2],
				}),
			],
			{ now: MON },
		);
		expect(out.recap.map((week) => week.tasks[0]?.hours)).toEqual([3, 1]);
		expect(out.recap.map((week) => week.prs)).toEqual([1, 1]);
		expect(out.weeks.map((week) => week.agentHours)).toEqual([3, 1]);
		expect(out.sessions).toBe(1);
	});

	test("sub-minute sessions that shipped nothing are left out", () => {
		const out = computeWorkload(
			[
				session({ sessionId: "blip", intervals: [[MON, MON + 20_000]] }),
				session({
					sessionId: "quick-pr",
					intervals: [[MON, MON + 20_000]],
					prs: ["https://github.com/o/r/pull/2"],
					prAt: [null],
				}),
				session({ sessionId: "work" }),
			],
			{ now: MON },
		);
		expect(out.recap[0]?.tasks.map((task) => task.sessionId)).toEqual([
			"work",
			"quick-pr",
		]);
		expect(out.sessions).toBe(2);
	});

	test("a repo filter narrows every number but still lists every repo", () => {
		const sessions = [
			session({
				sessionId: "a",
				repo: "odin",
				intervals: [[MON, MON + HOUR]],
			}),
			session({
				sessionId: "b",
				repo: "dev",
				intervals: [[MON, MON + 2 * HOUR]],
			}),
		];
		const only = computeWorkload(sessions, { now: MON, only: "odin" });
		expect(only.sessions).toBe(1);
		expect(only.agentHours).toBe(1);
		expect(only.repos).toEqual(["dev", "odin"]);
		const hidden = computeWorkload(sessions, { now: MON, hide: ["odin"] });
		expect(hidden.byRepo.map((row) => row.repo)).toEqual(["dev"]);
		expect(hidden.recap[0]?.tasks.map((task) => task.sessionId)).toEqual(["b"]);
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

	test("the heatmap puts an hour on its own weekday, in its own week", () => {
		// Monday 09:00, and the Wednesday of the week before at 23:30.
		const wed = new Date(2026, 8, 9, 23, 30, 0).getTime();
		const out = computeWorkload(
			[session(), session({ sessionId: "b", intervals: [[wed, wed + HOUR]] })],
			{ now: MON },
		);
		expect(out.heatmap.map((week) => week.start)).toEqual([
			weekStart(wed),
			weekStart(MON),
		]);
		// Sunday is weekday 0, so Monday 09:00 is cell 24 + 9 of this week's row.
		expect(out.heatmap[1]?.minutes[24 + 9]).toBe(60);
		expect(out.heatmap[1]?.minutes.reduce((a, b) => a + b, 0)).toBe(60);
		// The overnight run splits: Wednesday 23:00 and Thursday 00:00.
		const before = out.heatmap[0]?.minutes ?? [];
		expect(before[3 * 24 + 23]).toBe(30);
		expect(before[4 * 24 + 0]).toBe(30);
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

describe("repoOfDir", () => {
	test("names the enclosing repo, and nothing for a folder outside one", () => {
		const home = mkdtempSync(join(tmpdir(), "repo-of-dir-"));
		mkdirSync(join(home, "odin", ".git"), { recursive: true });
		mkdirSync(join(home, "Dan Wedding"));
		expect(repoOfDir(join(home, "odin", "apps", "desktop"))).toBe("odin");
		// A worktree removed since: its path still walks up into the clone.
		expect(repoOfDir(join(home, "odin", ".worktrees", "diff-tab"))).toBe(
			"odin",
		);
		expect(repoOfDir(join(home, "Dan Wedding"))).toBeNull();
	});

	test("a repo holding other clones is general, not a repo", () => {
		const dev = mkdtempSync(join(tmpdir(), "repo-of-dir-"));
		mkdirSync(join(dev, ".git"));
		mkdirSync(join(dev, "imagen", "app-web-server", ".git"), {
			recursive: true,
		});
		expect(repoOfDir(dev)).toBeNull();
		expect(repoOfDir(join(dev, "imagen", "app-web-server"))).toBe(
			"app-web-server",
		);
	});
});

describe("repoForDirs", () => {
	const known: Record<string, string | null> = {
		"/dev": null,
		"/dev/a": "a",
		"/dev/b": "b",
	};
	test("votes by repo, so a general start doesn't outvote the clone worked in", () => {
		expect(
			repoForDirs(
				[
					["/dev", 90],
					["/dev/a", 10],
					["/dev/b", 4],
				],
				(dir) => known[dir] ?? null,
			),
		).toBe("a");
		expect(repoForDirs([["/dev", 90]], (dir) => known[dir] ?? null)).toBeNull();
	});
});

describe("openingLine", () => {
	test("names an automation's run by the first sentence of its brief", () => {
		const jsonl = JSON.stringify({
			type: "user",
			message: {
				content:
					"Triage one bug report from Imagen Studio. A photographer hit Report.",
			},
		});
		expect(openingLine(jsonl)).toBe(
			"Triage one bug report from Imagen Studio.",
		);
	});
});

describe("humanIntervals", () => {
	const at = (m: number) => new Date(Date.UTC(2026, 8, 14, 9, m)).toISOString();
	const entry = (m: number, extra: object = {}) =>
		JSON.stringify({ type: "user", timestamp: at(m), ...extra });
	test("counts the gap before each typed prompt, capped at five minutes", () => {
		const jsonl = [
			entry(0, { promptSource: "typed" }), // opening: nothing to read yet
			entry(1), // agent reply
			entry(3, { promptSource: "typed" }), // 2m reading + typing
			entry(4), // agent reply
			entry(64, { promptSource: "typed" }), // back after an hour: 5m, not 60
			entry(65, { promptSource: "system" }), // not you
		].join("\n");
		const sorted = [0, 1, 3, 4, 64, 65].map((m) => Date.parse(at(m)));
		expect(totalMs(humanIntervals(jsonl, sorted))).toBe(7 * MINUTE);
	});
});
