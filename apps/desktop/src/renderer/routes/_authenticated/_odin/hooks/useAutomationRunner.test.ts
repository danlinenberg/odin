import { describe, expect, test } from "bun:test";
import { buildPrompt } from "renderer/hooks/useLaunchTaskSession";
import type { Pane } from "shared/tabs-types";
import {
	adoptableRun,
	automationRun,
	dueAutomations,
	hostAutomations,
	runKey,
	upcomingRuns,
} from "./useAutomationRunner";
import type { OdinTask } from "./useOdinTasks";

const task = (over: Partial<OdinTask>): OdinTask => ({
	id: "a",
	title: "Sweep the PR queue",
	notes: "",
	createdAt: 0,
	...over,
});

const at = (iso: string) => new Date(iso);
const due = (tasks: OdinTask[], iso: string) =>
	dueAutomations(tasks, at(iso)).map((t) => t.id);

describe("dueAutomations", () => {
	test("fires on the minute the cron names", () => {
		const rows = [task({ cron: "0 9 * * *" })];
		expect(due(rows, "2026-09-20T09:00:12")).toEqual(["a"]);
		expect(due(rows, "2026-09-20T09:01:12")).toEqual([]);
	});

	test("a plain task is never due", () => {
		expect(due([task({})], "2026-09-20T09:00")).toEqual([]);
	});

	test("paused stops the clock", () => {
		expect(
			due([task({ cron: "0 9 * * *", paused: true })], "2026-09-20T09:00"),
		).toEqual([]);
	});

	test("the second tick in the same minute doesn't fire it again", () => {
		const fired = at("2026-09-20T09:00").getTime();
		const rows = [task({ cron: "0 9 * * *", lastRunAt: fired })];
		expect(due(rows, "2026-09-20T09:00:45")).toEqual([]);
		// ...but tomorrow's run is still on.
		expect(due(rows, "2026-09-21T09:00:00")).toEqual(["a"]);
	});

	test("runs even with the last run's session still on the board", () => {
		// The schedule is the only say in it: pause is the off switch, and the
		// capacity gate in `launch` is what stops a fast cron flattening the Mac.
		expect(
			due([task({ cron: "0 9 * * *", paneId: "p1" })], "2026-09-20T09:00"),
		).toEqual(["a"]);
	});

	test("a broken expression is inert, not a crash", () => {
		expect(due([task({ cron: "every morning" })], "2026-09-20T09:00")).toEqual(
			[],
		);
	});
});

const pane = (over: Partial<Pane>): Pane =>
	({
		id: "p1",
		odinTaskTitle: "Ship it",
		status: "idle",
		...over,
	}) as Pane;

describe("automationRun", () => {
	test("no tags: the plain prompt, whatever the board holds", () => {
		expect(automationRun(task({}), {})).toEqual({
			description: null,
			brief: "Sweep the PR queue",
		});
	});

	test("tags with no session carrying one: skipped", () => {
		const panes = {
			p1: pane({ odinTags: ["bug"] }),
			p2: pane({ id: "p2", odinTags: ["codex-review"], completed: true }),
		};
		expect(automationRun(task({ tags: ["codex-review"] }), panes)).toBe(null);
	});

	test("lists only the open sessions that carry a watched tag", () => {
		const panes = {
			p1: pane({ odinTags: ["codex-review"], status: "review" }),
			p2: pane({ id: "p2", odinTaskTitle: "Other", odinTags: ["bug"] }),
		};
		const run = automationRun(
			task({ tags: ["codex-review"], notes: "Review them" }),
			panes,
		);
		// The description is what the agent's prompt is built from.
		const prompt = buildPrompt("Sweep the PR queue", run?.description ?? null);
		expect(prompt).toContain("Review them");
		expect(prompt).toContain("- Ship it - paneId p1, status review");
		expect(prompt).not.toContain("Other");
		expect(prompt).toContain("drop #codex-review from its tags");
		expect(run?.brief).toContain("- Ship it - paneId p1");
	});
});

describe("automations on the remote host", () => {
	test("the host gets the scheduled, running, untagged ones not kept on this Mac", () => {
		const rows = [
			task({ id: "ok", cron: "0 9 * * *" }),
			task({ id: "plain" }),
			task({ id: "paused", cron: "0 9 * * *", paused: true }),
			task({ id: "here", cron: "0 9 * * *", here: true }),
			task({ id: "tagged", cron: "0 9 * * *", tags: ["review"] }),
			task({ id: "bad", cron: "nope" }),
		];
		expect(hostAutomations(rows).map((t) => t.id)).toEqual(["ok"]);
	});

	test("run times cover the days ahead, on the minute, capped", () => {
		const from = at("2026-09-20T08:30:20");
		const runs = upcomingRuns("0 9 * * *", from, 3);
		expect(runs.map((s) => new Date(s * 1000).toString())).toEqual([
			at("2026-09-20T09:00").toString(),
			at("2026-09-21T09:00").toString(),
			at("2026-09-22T09:00").toString(),
		]);
		expect(upcomingRuns("*/15 * * * *", from, 3, 5)).toHaveLength(5);
	});

	test("a run goes by its automation and its minute, as the host keys it", () => {
		expect(runKey("a", at("2026-09-20T09:00").getTime())).toBe(
			`auto:a:${at("2026-09-20T09:00").getTime() / 1000}`,
		);
	});

	test("a host run is taken in once, only when newer than the last run here", () => {
		const slot = at("2026-09-20T09:00").getTime() / 1000;
		const run = { schedule: "a", slot, sessionId: "s1", at: slot + 100 };
		const now = (slot + 200) * 1000;
		const rows = [task({ cron: "0 9 * * *" })];
		expect(adoptableRun(run, rows, new Set(), now)?.id).toBe("a");
		expect(adoptableRun(run, rows, new Set(["s1"]), now)).toBeNull();
		expect(
			adoptableRun(
				run,
				[task({ cron: "0 9 * * *", lastRunAt: slot * 1000 })],
				new Set(),
				now,
			),
		).toBeNull();
		expect(
			adoptableRun({ ...run, schedule: "gone" }, rows, new Set(), now),
		).toBeNull();
		expect(adoptableRun(run, rows, new Set(), now + 5 * 86_400_000)).toBeNull();
	});
});
