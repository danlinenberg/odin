import { useMemo } from "react";
import { useOdinFeeds } from "./useOdinFeeds";
import { type OdinTask, useMyTasks } from "./useOdinTasks";

/**
 * The automations Odin ships with — installed on first run, already on.
 *
 * An empty Automations panel only pays off for someone who already knows what
 * to schedule. These are the jobs worth running for everyone, running from
 * launch, and each is an ordinary task row afterwards: pause it, retime it,
 * rewrite its prompt, delete it. Deleting is remembered (`seeded` in the task
 * store), so a built-in you threw away doesn't come back next launch.
 */

/** One thing sitting in the backlog, flattened out of whichever feed holds it. */
export interface BacklogItem {
	/** Where it lives — "Tasks", "#eng" — so the report can name it back. */
	source: string;
	title: string;
	/** The rest of what was written or said; where a ticket key usually hides. */
	detail?: string;
	/** A permalink, when the row has one. */
	url?: string;
	/** When it landed, ms. Age is most of the staleness signal. */
	at: number;
}

/**
 * The backlog, for the purpose of asking whether it's still worth doing: my own
 * tasks and the Slack queue.
 *
 * Not the whole All feed. Jira, PRs and Notion are live queries against their
 * source — the Jira feed asks for open issues, the PR feed for open PRs — so a
 * closed ticket and a merged PR leave those tabs on the next sync without
 * anyone reviewing anything. These two are the ones with nothing upstream to
 * retire a row: a task I typed exists only in Odin, and a :eyes: stays on a
 * Slack message long after somebody else answered the thread.
 */
export function backlogOf(
	todos: OdinTask[],
	slack: {
		title: string;
		text: string;
		status: string;
		permalink: string | null;
		channelName: string | null;
		postedAt: string;
	}[],
): BacklogItem[] {
	return [
		...todos.map((task) => ({
			source: "Tasks",
			title: task.title,
			detail: task.notes,
			at: task.createdAt,
		})),
		...slack
			// Same cut the tab badge and the All feed make: started and done rows
			// have already been dealt with.
			.filter((row) => row.status === "Not started")
			.map((row) => ({
				source: row.channelName ?? "Slack",
				title: row.title,
				detail: row.text,
				...(row.permalink ? { url: row.permalink } : {}),
				at: Date.parse(row.postedAt) || 0,
			})),
	];
}

/** The live backlog — what the sweep reads, wherever it's launched from. */
export function useBacklog(): BacklogItem[] {
	const { todos } = useMyTasks();
	const { reactions } = useOdinFeeds();
	const rows = reactions.data?.rows;
	return useMemo(() => backlogOf(todos, rows ?? []), [todos, rows]);
}

const DAY = 86_400_000;

/** One item, in the three lines the agent needs to go and check it. */
function renderItem(item: BacklogItem, index: number, now: number): string {
	const days = Math.max(0, Math.round((now - item.at) / DAY));
	return [
		`${index + 1}. [${item.source}] ${item.title} — ${days}d old`,
		item.url && `   link: ${item.url}`,
		// Flattened and clipped: a pasted stack trace is not worth 200 lines of
		// prompt, and the reference we're after is in the first sentence.
		item.detail?.trim() &&
			`   said: ${item.detail.replace(/\s+/g, " ").trim().slice(0, 280)}`,
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * The backlog sweep's prompt.
 *
 * The list is pasted in rather than fetched, because there is nothing to fetch
 * it from: the tasks live in renderer localStorage and the Slack queue behind
 * an Electron IPC call, neither of which an agent in a terminal can reach.
 *
 * Read-only on purpose. The verdict is a judgement call and the delete is one
 * click — an agent that closed tickets and cleared queues on a Monday morning
 * schedule would be one bad inference away from losing real work.
 */
export function backlogSweepBrief(
	items: BacklogItem[],
	now: number = Date.now(),
): string {
	if (items.length === 0)
		return "The backlog is empty right now — nothing to check. Say so and stop.";
	return [
		`The backlog as it stands on ${new Date(now).toLocaleString()} — ${items.length} item${items.length === 1 ? "" : "s"}. It lives inside Odin and you can't read it from there, so here it is:`,
		"",
		items.map((item, i) => renderItem(item, i, now)).join("\n"),
		"",
		"For EACH numbered item:",
		"1. Find its upstream reference in the title, what was said, or the link — a Jira key (ABC-1234), a Slack permalink, a GitHub PR or issue URL, a Notion page.",
		"2. Look up what that reference says NOW, using the tools you have here: the Jira skill, `gh pr view` / `gh issue view`, the Slack tools, or fetching the URL. For a Slack thread, read the replies — someone else having answered it is what resolved looks like.",
		"3. Give it one verdict:",
		"   - DROP — already done, or no longer wanted: ticket Closed/Done/Won't Do, PR merged or closed, thread answered, page archived.",
		"   - KEEP — still open, still worth doing.",
		"   - UNKNOWN — nothing to check against, or you couldn't reach it. Say which.",
		"",
		"Rules:",
		// Every Odin session ends with "make the changes, and verify them" —
		// appended by the launcher, after this text. For a sweep that is the
		// opposite of the job, so say which one wins rather than leaving the
		// agent to guess from the order.
		"- Read only, and that outranks the standing instruction below to make changes. Touch nothing anywhere: no closing tickets, no comments, no Slack messages or reactions, no code, no commits. Report and stop.",
		'- DROP needs the state you actually read, quoted — "BUGT-1234 is Done, resolved 12 Mar". No evidence is UNKNOWN, never DROP.',
		"- Old is not dead. An item with no upstream reference is UNKNOWN however long it has sat there.",
		"",
		"Report one table — number, item, verdict, the evidence in a few words — and put every DROP in ACTION ITEMS as a list I can clear in one pass.",
	].join("\n");
}

export interface BuiltinAutomation {
	/** Stable id. Also the dedupe key, so a deleted built-in stays deleted. */
	id: string;
	title: string;
	notes: string;
	cron: string;
	/** Context only this app can see, rendered into the prompt at launch. */
	context?: (backlog: BacklogItem[]) => string;
}

export const BUILTIN_AUTOMATIONS: BuiltinAutomation[] = [
	{
		id: "backlog-sweep",
		title: "Is the backlog still worth doing?",
		notes:
			"Check every open task and queued Slack message against the system it came from, and report what can be dropped.",
		// Monday 09:00. A backlog rots over weeks, not hours, and this reads the
		// whole list every time it runs — daily would be the same answer five
		// times and five agent sessions to close.
		cron: "0 9 * * 1",
		context: backlogSweepBrief,
	},
];

/**
 * The prompt body a run starts from: what's written on the task, plus whatever
 * live context its built-in needs. An ordinary task is just its notes.
 */
export function automationDescription(
	task: OdinTask,
	backlog: BacklogItem[],
): string | null {
	const render = BUILTIN_AUTOMATIONS.find(
		(builtin) => builtin.id === task.builtin,
	)?.context;
	return [task.notes, render?.(backlog)].filter(Boolean).join("\n\n") || null;
}
