import { describe, expect, test } from "bun:test";
import { isValidCron } from "shared/cron";
import {
	automationDescription,
	BUILTIN_AUTOMATIONS,
	backlogOf,
	backlogSweepBrief,
} from "./builtin-automations";
import type { OdinTask } from "./useOdinTasks";
import { useOdinTasks } from "./useOdinTasks";

const NOW = Date.parse("2026-09-21T09:00:00Z");

const task = (over: Partial<OdinTask>): OdinTask => ({
	id: "t1",
	title: "Chase BUGT-1234",
	notes: "",
	createdAt: NOW - 30 * 86_400_000,
	...over,
});

const slackRow = (over: Record<string, unknown> = {}) => ({
	title: "can someone look at the export timeout",
	text: "can someone look at the export timeout",
	status: "Not started",
	permalink: "https://slack.com/archives/C1/p123",
	channelName: "#eng",
	postedAt: "2026-08-01T10:00:00Z",
	...over,
});

describe("backlogOf", () => {
	test("takes my tasks and the messages still queued", () => {
		const items = backlogOf([task({})], [slackRow()]);
		expect(items.map((item) => item.source)).toEqual(["Tasks", "#eng"]);
		expect(items[1]?.url).toBe("https://slack.com/archives/C1/p123");
	});

	test("drops Slack rows already started or done", () => {
		const rows = [
			slackRow({ status: "In progress" }),
			slackRow({ status: "Done" }),
		];
		expect(backlogOf([], rows)).toEqual([]);
	});
});

describe("backlogSweepBrief", () => {
	test("lists every item, with its age and link, for the agent to check", () => {
		const brief = backlogSweepBrief(
			backlogOf([task({ notes: "waiting on the fix" })], [slackRow()]),
			NOW,
		);
		expect(brief).toContain("1. [Tasks] Chase BUGT-1234 — 30d old");
		expect(brief).toContain("said: waiting on the fix");
		expect(brief).toContain("link: https://slack.com/archives/C1/p123");
		// The verdicts the report is scored on, and the rule that keeps a
		// guess out of the DROP column.
		expect(brief).toContain("DROP");
		expect(brief).toContain("UNKNOWN");
		// The launcher appends "make the changes" after this text — the sweep has
		// to say which one wins, or it's one inference from editing the repo.
		expect(brief).toContain("outranks the standing instruction below");
	});

	test("an empty backlog asks for nothing", () => {
		expect(backlogSweepBrief([], NOW)).toContain("nothing to check");
	});
});

describe("automationDescription", () => {
	test("a built-in gets its notes plus the live backlog", () => {
		const sweep = task({ builtin: "backlog-sweep", notes: "Check them all." });
		const text = automationDescription(sweep, backlogOf([task({})], []));
		expect(text).toContain("Check them all.");
		expect(text).toContain("Chase BUGT-1234");
	});

	test("an ordinary automation is still just what I wrote", () => {
		expect(automationDescription(task({ notes: "run the thing" }), [])).toBe(
			"run the thing",
		);
		expect(automationDescription(task({ notes: "" }), [])).toBeNull();
	});
});

describe("installBuiltins", () => {
	const reset = () => useOdinTasks.setState({ tasks: [], seeded: [] });
	const install = (profileId = "default") =>
		useOdinTasks.getState().installBuiltins(profileId, BUILTIN_AUTOMATIONS);

	test("every built-in is a valid schedule, so it actually fires", () => {
		for (const builtin of BUILTIN_AUTOMATIONS)
			expect(isValidCron(builtin.cron)).toBe(true);
	});

	test("installs once, on by default", () => {
		reset();
		install();
		const { tasks } = useOdinTasks.getState();
		expect(tasks).toHaveLength(BUILTIN_AUTOMATIONS.length);
		expect(tasks[0]?.cron).toBeTruthy();
		expect(tasks[0]?.paused).toBeUndefined();
		install();
		expect(useOdinTasks.getState().tasks).toHaveLength(
			BUILTIN_AUTOMATIONS.length,
		);
	});

	test("a built-in I deleted stays deleted", () => {
		reset();
		install();
		for (const row of useOdinTasks.getState().tasks)
			useOdinTasks.getState().remove(row.id);
		install();
		expect(useOdinTasks.getState().tasks).toEqual([]);
	});

	test("each profile gets its own copy", () => {
		reset();
		install("work");
		install("personal");
		expect(useOdinTasks.getState().tasks.map((row) => row.profileId)).toEqual([
			"personal",
			"work",
		]);
	});
});
