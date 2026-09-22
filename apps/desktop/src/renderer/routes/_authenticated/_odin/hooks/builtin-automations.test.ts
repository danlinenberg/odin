import { describe, expect, test } from "bun:test";
import { isValidCron } from "shared/cron";
import {
	BUILTIN_AUTOMATIONS,
	type BuiltinAutomation,
	backlogOf,
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

	// The sweep's cheapest verdict rides on this flag: no reaction on the
	// message means somebody dealt with it.
	test("carries through that the :eyes: is gone", () => {
		const items = backlogOf([], [slackRow({ unreacted: true })]);
		expect(items[0]?.unreacted).toBe(true);
		expect(backlogOf([], [slackRow()])[0]?.unreacted).toBeUndefined();
	});

	// The key is what a DROP acts on, so it has to name the row *and* which
	// store it lives in — the two id spaces are unrelated and could collide.
	test("keys each item back to the row it came from", () => {
		expect(
			backlogOf([task({ id: "abc" })], [slackRow()]).map((i) => i.key),
		).toEqual(["task:abc", "slack:C1:123"]);
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
