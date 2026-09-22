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
	 * What to clear when the verdict is DROP: `task:<id>` or
	 * `slack:<channel>:<ts>`. Also how a verdict finds its way back to the row
	 * it is about, and — for a Slack row — the message the sweep reads.
	 */
	key: string;
	/** Where it lives — "Tasks", "#eng" — so the report can name it back. */
	source: string;
	title: string;
	/** The rest of what was written or said; where a ticket key usually hides. */
	detail?: string;
	/** A permalink, when the row has one. */
	url?: string;
	/** Slack only: the :eyes: that queued this is gone from the message. */
	unreacted?: boolean;
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
		unreacted?: boolean;
	}[],
): BacklogItem[] {
	return [
		...todos.map((task) => ({
			key: `task:${task.id}`,
			source: "Tasks",
			title: task.title,
			detail: task.notes,
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
				...(row.unreacted ? { unreacted: true } : {}),
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
 * The backlog sweep shipped here first, on a Monday cron, as a session that
 * went and read the tickets. Both were the wrong shape: its whole output is a
 * set of decisions, which belong on a screen rather than in a terminal on a
 * morning you might not open Odin, and the reading is three API calls Odin can
 * make itself. It is a button on the Review screen now, and Odin's own code.
 *
 * The machinery stays — seeding, the built-in chip, and the retirement below
 * that takes a row away again once it stops shipping.
 */
export const BUILTIN_AUTOMATIONS: BuiltinAutomation[] = [];
