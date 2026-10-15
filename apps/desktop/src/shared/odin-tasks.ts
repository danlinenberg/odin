import { cronMatches, parseCron } from "./cron";

/**
 * One thing I decided to do myself - the feed with no upstream system behind
 * it. Jira, Slack and PRs are mirrors of other people's queues; this is the
 * list you type into when the thing you have to do isn't a ticket yet.
 *
 * Shared, not renderer-only: on a remote server the automations run there
 * (main/odin-core/scheduler), off the same rows.
 */
export interface OdinTask {
	id: string;
	/** First line - names the card, the tab and the session. */
	title: string;
	/** The rest of what you typed: the actual ask, sent as the prompt. */
	notes: string;
	createdAt: number;
	/** 1–3 - Low, Medium, High (PRIORITY_LABELS). Absent (or 0) reads as Medium. */
	priority?: number;
	/** The session started from this task, once there is one. */
	paneId?: string;
	/**
	 * The profile that wrote it. Work todos and personal todos are different
	 * lists. Absent on tasks written before profiles - those read as default.
	 */
	profileId?: string;
	/**
	 * A five-field cron (or an `@daily` shorthand). Set = this is an
	 * automation: the runner starts it on the schedule instead of you, and it
	 * stays on the list afterwards. Absent = an ordinary one-shot task.
	 */
	cron?: string;
	/** Scheduled but held. The row stays; the clock stops. */
	paused?: boolean;
	/** The minute the schedule last fired, so one tick can't fire it twice. */
	lastRunAt?: number;
	/**
	 * The skill this runs - `gdpr`, `imagen-core:triage`. The session opens by
	 * invoking it, with the title as its argument, so a task that is really
	 * "run /ship-status" says so on the card instead of hiding it in prose.
	 */
	skill?: string;
	/**
	 * The checkout the session runs in. Absent = the workspace folder, where
	 * the agent works out the repo from the brief.
	 */
	repo?: string;
	/**
	 * The built-in this row was installed from (`backlog-sweep`). Set = Odin
	 * wrote it, and the runner fills its prompt with context only the app can
	 * see. Everything else about it is an ordinary task: edit it, retime it,
	 * pause it, throw it away.
	 */
	builtin?: string;
	/** Set = a due run is skipped unless an open session carries one of these. */
	tags?: string[];
}

/** Scheduled, so it runs itself - the one thing automations don't share. */
export const isAutomation = (task: OdinTask): boolean => !!task.cron;

/** Where the Tasks panel's editor points an image saved to ~/.odin/attachments. */
export const ATTACHMENT_URL = "odin-attachment://file/";

/** The prompt a task launches with - what you typed, minus the "!"s. */
export function taskPrompt(task: OdinTask): string {
	const notes = taskNotes(task);
	return notes ? `${task.title}\n\n${notes}` : task.title;
}

/** The notes as the session reads them. */
export function taskNotes(task: OdinTask): string {
	// An image the description editor saved is shown via odin-attachment://;
	// the session needs the file itself.
	return task.notes.replaceAll(ATTACHMENT_URL, "~/.odin/attachments/");
}

/**
 * Which automations are due right now.
 *
 * `lastRunAt` is the whole dedupe: a minute gets visited by two ticks, and
 * this is what stops the second one starting the job again. Split out from
 * the hook so the rule is testable without a renderer.
 *
 * The schedule is the only say in it - a due run starts even if the last
 * one's session is still open on the board. Pause is how you stop it; the
 * machine-capacity gate in `launch` is what keeps a fast cron from flattening
 * the Mac.
 *
 * ponytail: no catch-up. An automation that came due while the app was shut
 * is skipped, not run at launch - opening Odin on Monday morning should not
 * fire the weekend's three missed runs at once.
 */
export function dueAutomations(tasks: OdinTask[], now: Date): OdinTask[] {
	const minute = new Date(now).setSeconds(0, 0);
	return tasks.filter((task) => {
		if (!task.cron || task.paused) return false;
		if ((task.lastRunAt ?? 0) >= minute) return false;
		const cron = parseCron(task.cron);
		return !!cron && cronMatches(cron, now);
	});
}

/** The fields of a pane the automations look at. */
export interface TaggedPane {
	id: string;
	odinTaskTitle?: string;
	completed?: boolean;
	odinTags?: string[];
	status?: string;
}

export function taggedSessions<P extends TaggedPane>(
	panes: Record<string, P>,
	tags: readonly string[],
): P[] {
	return Object.values(panes).filter(
		(pane) =>
			pane.odinTaskTitle &&
			!pane.completed &&
			pane.odinTags?.some((tag) => tags.includes(tag)),
	);
}

/**
 * What a run launches with. Null = skip it: it watches tags and no open
 * session carries one. The tagged sessions ride in `description`, the text
 * the agent's prompt is built from - `brief` is only kept on the card.
 */
export function automationRun(
	task: OdinTask,
	panes: Record<string, TaggedPane>,
): { description: string | null; brief: string } | null {
	const notes = taskNotes(task);
	if (!task.tags?.length)
		return { description: notes || null, brief: taskPrompt(task) };
	const sessions = taggedSessions(panes, task.tags);
	if (sessions.length === 0) return null;
	const description = [
		...(notes ? [notes, ""] : []),
		`Sessions on the board tagged ${task.tags.map((tag) => `#${tag}`).join(" or ")} (paneId is what Odin's local API takes):`,
		...sessions.map(
			(pane) =>
				`- ${pane.odinTaskTitle} - paneId ${pane.id}, status ${pane.status ?? "idle"}, tags ${(pane.odinTags ?? []).map((tag) => `#${tag}`).join(" ")}`,
		),
		"",
		// Without this the tag stays, and every tick runs the same session again.
		`When you finish with a session, drop ${task.tags.map((tag) => `#${tag}`).join(" / ")} from its tags so the next run skips it: curl -sf http://127.0.0.1:$ODIN_PORT/odin --data-urlencode action=set --data-urlencode store=sessions --data-urlencode 'patch={"panes":{"<paneId>":{"odinTags":[<its other tags>]}}}'`,
	].join("\n");
	return { description, brief: `${task.title}\n\n${description}` };
}
