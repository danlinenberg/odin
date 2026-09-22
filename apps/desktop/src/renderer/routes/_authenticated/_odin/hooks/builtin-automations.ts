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
	/**
	 * What to clear when the verdict is DROP: `task:<id>` or `slack:<id>`.
	 *
	 * Never sent to the agent. It answers with the item's number, and the app
	 * maps that back through the snapshot it took when it built the prompt —
	 * identity stays on our side of the wire, where a hallucinated id can't
	 * delete the wrong row.
	 */
	key: string;
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
		id: string;
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
			key: `task:${task.id}`,
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
				key: `slack:${row.id}`,
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
 * The answers come back the same way round — a file, because an agent in a
 * terminal has no route into the renderer either.
 *
 * Read-only on purpose. The verdict is a judgement call and the clearing is a
 * click on the Review screen — an agent that closed tickets and cleared queues
 * itself would be one bad inference away from losing real work.
 */
export function backlogSweepBrief(
	items: BacklogItem[],
	reviewPath: string,
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
		// The operative output. The table is for reading over your shoulder; this
		// is the bit Odin acts on, so it says so, names every field, and insists
		// on all of them — a row the parser drops is an item that silently never
		// gets reviewed.
		`When you are done, write your verdicts to \`${reviewPath}\` (create the directory if it is missing). That file is what Odin reads to build the review screen, so write it even if every verdict is KEEP.`,
		"A JSON array, one object per numbered item, nothing else in the file:",
		'  [{"n": 1, "verdict": "DROP", "evidence": "BUGT-1234 is Done, resolved 12 Mar"}]',
		'- `n` is the item\'s number above. `verdict` is exactly "DROP", "KEEP" or "UNKNOWN". `evidence` is the one line you would have put in the table.',
		"- Every item gets a row, including the ones you could not reach.",
		"",
		"Then report the same thing as one table — number, item, verdict, the evidence in a few words — so it can be read without opening the file.",
	].join("\n");
}

export interface BuiltinAutomation {
	/** Stable id. Also the dedupe key, so a deleted built-in stays deleted. */
	id: string;
	title: string;
	notes: string;
	cron: string;
}

/**
 * Empty, on purpose.
 *
 * The backlog sweep shipped here first, on a Monday cron. It was the wrong
 * shape: a sweep whose whole output is a set of decisions should put those
 * decisions on a screen, not into a terminal on a morning you might not open
 * Odin. It now lives on the Review screen and runs when you ask it to.
 *
 * The machinery stays — seeding, the built-in chip, and the retirement below
 * that takes a row away again once it stops shipping.
 */
export const BUILTIN_AUTOMATIONS: BuiltinAutomation[] = [];
