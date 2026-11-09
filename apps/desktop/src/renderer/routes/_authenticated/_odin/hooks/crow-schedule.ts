import { isValidCron, nextRun } from "shared/cron";
import { useOdinTasks } from "./useOdinTasks";

/** useMyTasks().add: text, cron, repo - in the active profile, returns the id. */
type AddTask = (
	text: string,
	cron?: string,
	repo?: string,
) => string | undefined;

/**
 * action=schedule: a new row on Automations → Schedules, the same one its
 * "Add automation" button makes - a task with a cron - plus the row's own
 * "On this Mac" and tag controls. `cron` is required: without it this would be
 * an ordinary task, which is action=add.
 */
export function addSchedule(
	args: Record<string, string>,
	add: AddTask,
): string {
	if (!args.text?.trim()) return "Need text.";
	const cron = args.cron?.trim() ?? "";
	if (!cron) return "Need cron (five fields, e.g. 0 9 * * 1-5, or @daily).";
	if (!isValidCron(cron))
		return `"${cron}" is not a cron: five fields (minute hour day month weekday) or @hourly/@daily/@weekly/@monthly.`;
	const id = add(args.text, cron, args.repo || undefined);
	if (!id) return "Need text.";
	const store = useOdinTasks.getState();
	if (args.here === "true") store.setHere(id, true);
	const tags = (args.tags ?? "")
		.split(",")
		.map((tag) => tag.trim().replace(/^#/, ""))
		.filter(Boolean);
	if (tags.length) store.setTags(id, tags);
	if (args.paused === "true") store.setPaused(id, true);
	const task = useOdinTasks.getState().tasks.find((t) => t.id === id);
	const next = args.paused === "true" ? null : nextRun(cron);
	return JSON.stringify({
		added: task?.title,
		id,
		cron,
		next: next ? next.toISOString() : null,
		here: task?.here ?? false,
		tags: task?.tags ?? [],
		paused: task?.paused ?? false,
	});
}
