import { useMemo } from "react";
import { useDoneStore } from "renderer/stores/done";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useOdinFeeds } from "./useOdinFeeds";
import { type OdinTask, useMyTasks } from "./useOdinTasks";

/**
 * The automations Odin ships with - installed on first run, already on.
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
	 * it is about, and - for a Slack row - the message the sweep reads.
	 */
	key: string;
	/** Where it lives - "Tasks", "#eng" - so the report can name it back. */
	source: string;
	title: string;
	/** The rest of what was written or said; where a ticket key usually hides. */
	detail?: string;
	/** Who it's from: the Slack author, the Jira reporter, the PR author. */
	person?: string;
	/** A permalink, when the row has one. */
	url?: string;
	/** Slack only: the :eyes: that queued this is gone from the message. */
	unreacted?: boolean;
	/** When the source last moved, ms - what the sweep ages a quiet row against. */
	lastActivityAt?: number;
	/** When it was first written, ms - the task made, the message posted, the ticket filed. */
	createdAt?: number;
	/** The source's own status name, where it keeps one: a Notion row's Status. */
	status?: string;
	/** An email row's sender, as the mail client shows it. */
	sender?: string;
}

/** The first of these that carries an email address. */
function senderOf(
	...fields: (string | null | undefined)[]
): string | undefined {
	return fields.find((field) => field?.includes("@")) ?? undefined;
}

/** An ISO date from a feed as ms, or undefined when the feed left it out. */
function movedAt(iso: string | null | undefined): number | undefined {
	if (!iso) return undefined;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The backlog, for the purpose of asking whether it's still worth doing:
 * everything on the board, whatever feed it came from.
 *
 * Jira, PRs and Notion do retire their own rows - the Jira feed asks for open
 * issues, the PR feed for open PRs, so a closed ticket and a merged PR leave
 * those tabs on the next sync with nobody reviewing anything. That answers
 * "is it finished", which was never the whole question. An issue still open
 * after two months of silence is exactly the thing this screen is for, and it
 * is invisible to a feed that only knows open from closed.
 *
 * So every source is swept, and each brings the timestamp its own API calls
 * "last touched". What differs is what a DROP can then do: a task is deleted
 * and a Slack row gets the local handled marker, while a Jira, PR or Notion
 * row has nothing local to clear and the Review screen can only take it off
 * the list - it comes back on the next sweep unless it moves at the source.
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
		postedAt?: string;
		unreacted?: boolean;
		authorName?: string | null;
	}[],
	jira: {
		key: string;
		url: string;
		title: string;
		updated: string | null;
		created?: string | null;
		reporter?: string | null;
	}[] = [],
	pulls: {
		repo: string;
		number: number;
		url: string;
		title: string;
		updated: string | null;
		created?: string | null;
		author?: string;
	}[] = [],
	notion: {
		pageId: string;
		pageUrl: string;
		title: string;
		updatedAt: string | null;
		status?: string | null;
		slackUrl?: string | null;
		channel?: string | null;
		contact?: string | null;
		assignee?: string | null;
	}[] = [],
): BacklogItem[] {
	return [
		...todos.map((task) => ({
			key: `task:${task.id}`,
			source: "Tasks",
			title: task.title,
			detail: task.notes,
			lastActivityAt: task.createdAt,
			createdAt: task.createdAt,
		})),
		...slack
			// Done rows have been dealt with. Started ones stay: a session still
			// working a thread someone else already answered is exactly what the
			// sweep should catch, and Review names the session to stop.
			.filter((row) => row.status !== "Done")
			.map((row) => ({
				key: `slack:${row.id}`,
				source: row.channelName ?? "Slack",
				title: row.title,
				detail: row.text,
				...(row.permalink ? { url: row.permalink } : {}),
				...(row.authorName ? { person: row.authorName } : {}),
				...(row.unreacted ? { unreacted: true } : {}),
				...(movedAt(row.postedAt)
					? {
							lastActivityAt: movedAt(row.postedAt),
							createdAt: movedAt(row.postedAt),
						}
					: {}),
			})),
		...jira.map((issue) => ({
			key: `jira:${issue.key}`,
			source: "Jira",
			// The key goes in the detail so the sweep's own reference-finder picks
			// it up, the same way it would out of a Slack message that named it.
			title: issue.title,
			detail: issue.key,
			url: issue.url,
			...(issue.reporter ? { person: issue.reporter } : {}),
			...(movedAt(issue.updated)
				? { lastActivityAt: movedAt(issue.updated) }
				: {}),
			...(movedAt(issue.created) ? { createdAt: movedAt(issue.created) } : {}),
		})),
		...pulls.map((pull) => ({
			key: `pr:${pull.repo}#${pull.number}`,
			source: pull.repo,
			title: pull.title,
			url: pull.url,
			...(pull.author ? { person: pull.author } : {}),
			...(movedAt(pull.updated)
				? { lastActivityAt: movedAt(pull.updated) }
				: {}),
			...(movedAt(pull.created) ? { createdAt: movedAt(pull.created) } : {}),
		})),
		...notion.map((page) => ({
			key: `notion:${page.pageId}`,
			source: "Notion",
			title: page.title,
			url: page.pageUrl,
			// The Slack message an inbox row was copied from: the sweep reads its
			// thread, and knows it for the same message when it's a Slack row too.
			...(page.slackUrl ? { detail: page.slackUrl } : {}),
			...(page.status ? { status: page.status } : {}),
			// The address can sit in either field - Contact often holds only the
			// display name ("Imagen") and Point of Contact the "Imagen <info@…>".
			...(page.channel === "Gmail" && senderOf(page.contact, page.assignee)
				? { sender: senderOf(page.contact, page.assignee) }
				: {}),
			...(movedAt(page.updatedAt)
				? { lastActivityAt: movedAt(page.updatedAt) }
				: {}),
		})),
	];
}

/** The live backlog - what the sweep reads, wherever it's launched from. */
export function useBacklog(): BacklogItem[] {
	const { todos } = useMyTasks();
	const { reactions, jira, pulls, notion } = useOdinFeeds();
	const rows = reactions.data?.rows;
	const issues = jira.data?.issues;
	const prs = pulls.data?.pulls;
	const pages = notion.data?.rows;
	// A done row has been dealt with: the sweep has nothing to ask of it.
	// Keyed the way All tasks keys them; a PR also by link (see useDone).
	const done = useDoneStore((s) => s.done);
	// Messages a reaction auto-started: the reaction's job ended at the launch,
	// so taking it off afterwards says nothing about whether the work is done.
	const panes = useTabsStore((s) => s.panes);
	const autoStarted = useMemo(
		() =>
			new Set(
				Object.values(panes)
					.filter((pane) => pane.odinTags?.includes("auto-started"))
					.map((pane) => pane.odinPageId),
			),
		[panes],
	);
	return useMemo(() => {
		const urls = new Set(Object.values(done).map((row) => row.url));
		const live = (key: string, url?: string) =>
			!(key in done) && !(url && urls.has(url));
		return backlogOf(
			todos.filter((task) => live(`task:${task.id}`)),
			(rows ?? [])
				.filter((row) => live(`slack:${row.id}`))
				.map((row) =>
					autoStarted.has(row.id) ? { ...row, unreacted: false } : row,
				),
			(issues ?? []).filter((issue) => live(`jira:${issue.key}`)),
			(prs ?? []).filter((pull) => live(`pr:${pull.id}`, pull.url)),
			(pages ?? []).filter((page) => live(`notion:${page.pageId}`)),
		);
	}, [todos, rows, issues, prs, pages, done, autoStarted]);
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
 * The machinery stays - seeding, the built-in chip, and the retirement below
 * that takes a row away again once it stops shipping.
 */
export const BUILTIN_AUTOMATIONS: BuiltinAutomation[] = [];
