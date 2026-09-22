import { describe, expect, test } from "bun:test";
import { isValidCron } from "shared/cron";
import {
	BUILTIN_AUTOMATIONS,
	type BuiltinAutomation,
	backlogOf,
	backlogSweepBrief,
} from "./builtin-automations";
import type { OdinTask } from "./useOdinTasks";
import { useOdinTasks } from "./useOdinTasks";

const NOW = Date.parse("2026-09-21T09:00:00Z");
const REVIEW_PATH = "/Users/dan/.odin/backlog-review.json";

const task = (over: Partial<OdinTask>): OdinTask => ({
	id: "t1",
	title: "Chase BUGT-1234",
	notes: "",
	createdAt: NOW - 30 * 86_400_000,
	...over,
});

const slackRow = (over: Record<string, unknown> = {}) => ({
	id: "C1:123",
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

	// The key is what a DROP acts on, so it has to name the row *and* which
	// store it lives in — the two id spaces are unrelated and could collide.
	test("keys each item back to the row it came from", () => {
		expect(
			backlogOf([task({ id: "abc" })], [slackRow()]).map((i) => i.key),
		).toEqual(["task:abc", "slack:C1:123"]);
	});
});

describe("backlogSweepBrief", () => {
	test("lists every item, with its age and link, for the agent to check", () => {
		const brief = backlogSweepBrief(
			backlogOf([task({ notes: "waiting on the fix" })], [slackRow()]),
			REVIEW_PATH,
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

	// Without the file there is no Review screen, only a session transcript —
	// so the path and the shape are the two things the prompt can't lose.
	test("asks for the verdicts as JSON, at the path the app gave it", () => {
		const brief = backlogSweepBrief(
			backlogOf([task({})], []),
			REVIEW_PATH,
			NOW,
		);
		expect(brief).toContain(REVIEW_PATH);
		expect(brief).toContain('"n": 1');
		expect(brief).toContain("Every item gets a row");
	});

	// The item's identity never crosses the wire: the app maps number back to
	// row from its own snapshot, so a made-up key can't delete anything.
	test("never shows the agent an item's key", () => {
		const brief = backlogSweepBrief(
			backlogOf([task({ id: "abc" })], [slackRow()]),
			REVIEW_PATH,
			NOW,
		);
		expect(brief).not.toContain("task:abc");
		expect(brief).not.toContain("slack:C1:123");
	});

	test("an empty backlog asks for nothing", () => {
		expect(backlogSweepBrief([], REVIEW_PATH, NOW)).toContain(
			"nothing to check",
		);
	});
});

describe("installBuiltins", () => {
	const fixture: BuiltinAutomation[] = [
		{ id: "sample", title: "Sample", notes: "do it", cron: "0 9 * * 1" },
	];
	const reset = () => useOdinTasks.setState({ tasks: [], seeded: [] });
	const install = (
		profileId = "default",
		builtins: BuiltinAutomation[] = fixture,
	) => useOdinTasks.getState().installBuiltins(profileId, builtins);

	test("every built-in that ships is a valid schedule, so it actually fires", () => {
		for (const builtin of BUILTIN_AUTOMATIONS)
			expect(isValidCron(builtin.cron)).toBe(true);
	});

	test("installs once, on by default", () => {
		reset();
		install();
		const { tasks } = useOdinTasks.getState();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.cron).toBe("0 9 * * 1");
		expect(tasks[0]?.paused).toBeUndefined();
		install();
		expect(useOdinTasks.getState().tasks).toHaveLength(1);
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

	// The backlog sweep shipped as a built-in and then stopped being one. Its
	// row keeps its cron, so without this it goes on firing forever as an
	// automation nobody wrote and nobody can find the source of.
	test("a built-in Odin stopped shipping is taken off the list", () => {
		reset();
		install();
		expect(useOdinTasks.getState().tasks).toHaveLength(1);
		install("default", []);
		expect(useOdinTasks.getState().tasks).toEqual([]);
	});

	test("retiring one leaves my own automations alone", () => {
		reset();
		install();
		useOdinTasks.getState().add("my own job", "default", "0 9 * * 1");
		install("default", []);
		expect(useOdinTasks.getState().tasks.map((t) => t.title)).toEqual([
			"my own job",
		]);
	});
});
