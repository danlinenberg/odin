/** A task of mine and the helpers that need no React (the phone server on a remote host uses them). */

/**
 * One thing I decided to do myself - the feed with no upstream system behind
 * it. Jira, Slack and PRs are mirrors of other people's queues; this is the
 * list you type into when the thing you have to do isn't a ticket yet.
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
	/** The session started from this task, once there is one - the newest. */
	paneId?: string;
	/**
	 * Every session started from it, oldest first, the newest PANE_KEEP: a task
	 * can have several running at once. Absent on tasks started before.
	 */
	paneIds?: string[];
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
	 * The skill this runs - `gdpr`, `acme-core:triage`. The session opens by
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
	/** Runs on this computer even while the remote host takes new sessions. */
	here?: boolean;
}

/**
 * Priority by level - what the chip says and the select offers. Slot 0 is only
 * what tasks written before Medium was the default still hold; nothing writes
 * it any more and it reads as Medium.
 */
export const PRIORITY_LABELS = ["None", "Low", "Medium", "High"] as const;

/**
 * No "!"s means Medium. Everything you write down is something you mean to do -
 * "None" was a level that said nothing about when, and picking one on every
 * task is a tax. Say Low or High when it isn't the middle.
 */
export const DEFAULT_PRIORITY = 2;

/** A task's level, defaulting the ones stored before there was a default. */
export const priorityOf = (task: { priority?: number }): number =>
	task.priority || DEFAULT_PRIORITY;

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

/** Where the Tasks panel's editor points an image saved to ~/.odin/attachments. */
export const ATTACHMENT_URL = "odin-attachment://file/";
