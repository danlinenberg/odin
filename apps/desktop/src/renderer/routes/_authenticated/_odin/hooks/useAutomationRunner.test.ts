import { describe, expect, test } from "bun:test";
import { dueAutomations } from "./useAutomationRunner";
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
