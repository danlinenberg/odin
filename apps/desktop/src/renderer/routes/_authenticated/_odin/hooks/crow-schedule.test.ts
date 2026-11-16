import { beforeEach, expect, test } from "bun:test";
import { addSchedule } from "./crow-schedule";
import { isAutomation, useOdinTasks } from "./useOdinTasks";

const add = (text: string, cron?: string, repo?: string) =>
	useOdinTasks.getState().add(text, "default", cron, repo);

beforeEach(() => useOdinTasks.setState({ tasks: [] }));

test("addSchedule: Huginn adds a row to Schedules, On this Mac and tagged", () => {
	const reply = JSON.parse(
		addSchedule(
			{
				text: "Keep my PRs up to date\nRun gh pr update-branch on each open PR.",
				cron: "0 9-19/2 * * 1-5",
				here: "true",
				tags: "#prs, odin",
				repo: "/repos/odin",
			},
			add,
		),
	);
	const task = useOdinTasks.getState().tasks[0];
	if (!task) throw new Error("schedule was not added");
	expect(isAutomation(task)).toBe(true);
	expect(task).toMatchObject({
		title: "Keep my PRs up to date",
		notes: "Run gh pr update-branch on each open PR.",
		cron: "0 9-19/2 * * 1-5",
		here: true,
		tags: ["prs", "odin"],
		repo: "/repos/odin",
	});
	expect(reply).toMatchObject({ added: "Keep my PRs up to date", here: true });
	expect(reply.next).not.toBeNull();
});

test("addSchedule: no cron or a bad one adds nothing", () => {
	expect(addSchedule({ text: "Job" }, add)).toStartWith("Need cron");
	expect(addSchedule({ text: "Job", cron: "every 2h" }, add)).toContain(
		"is not a cron",
	);
	expect(addSchedule({ text: " ", cron: "@daily" }, add)).toBe("Need text.");
	expect(useOdinTasks.getState().tasks).toHaveLength(0);
});

test("addSchedule: paused starts held, with no next run", () => {
	const reply = JSON.parse(
		addSchedule({ text: "Job", cron: "@daily", paused: "true" }, add),
	);
	expect(reply).toMatchObject({ paused: true, next: null, here: false });
	expect(useOdinTasks.getState().tasks[0]?.paused).toBe(true);
});

test("addSchedule: a one-off says when it runs and pauses after its run", () => {
	const reply = JSON.parse(
		addSchedule({ text: "Send the report", cron: "0 9 20 11 *" }, add),
	);
	expect(reply.once).toBe(true);
	expect(reply.nextLocal).not.toBeNull();
	const id = useOdinTasks.getState().tasks[0]?.id as string;
	useOdinTasks.getState().markRun(id, Date.now());
	expect(useOdinTasks.getState().tasks[0]?.paused).toBe(true);
});
