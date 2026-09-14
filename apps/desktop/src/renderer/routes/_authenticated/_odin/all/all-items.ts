import type { FeedPath } from "../components/feed-counts";
import { isBot } from "../components/feed-counts";
import { PRIORITY_LABELS, priorityOf } from "../hooks/useOdinTasks";

/**
 * One row of the All feed — a task from any source, flattened to the few
 * things every source has: a name, where it came from, where to open it.
 */
export interface AllItem {
	/** Unique across sources — two systems can hand out the same id. */
	key: string;
	source: "Tasks" | "Slack" | "Jira" | "GitHub" | "Notion";
	/** The feed this row lives in — where its Start session button is. */
	to: FeedPath;
	title: string;
	/** Upstream link. My own tasks have none: they only exist in Odin. */
	url: string | null;
	/** Who it's from — the reporter, the author, the person who asked. */
	person: string | null;
	/** Where it stands upstream. My own tasks have no status but done. */
	status: string | null;
	/** Where it lives — the project, the repo, the channel. */
	context: string | null;
	/** However the source names it — High, Highest, P1. Ours are PRIORITY_LABELS. */
	priority: string | null;
	/** Sort key in ms. 0 when the source didn't date it. */
	at: number;
}

/** ISO → ms, and 0 for "no date" so an undated row sinks instead of throwing. */
function ms(iso: string | null | undefined): number {
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(t) ? 0 : t;
}

/**
 * Every feed as one list, newest first.
 *
 * Same rules the tab badges use — Slack counts only un-started messages, PRs
 * drop the bots — so All holds exactly what the other tabs claim between them
 * rather than being a second, larger truth.
 */
export function allItems(input: {
	tasks: {
		id: string;
		title: string;
		createdAt: number;
		priority?: number;
	}[];
	slack: {
		id: string;
		title: string;
		status: string;
		permalink: string | null;
		channelName: string | null;
		authorName: string | null;
		postedAt: string;
	}[];
	jira: {
		key: string;
		title: string;
		url: string;
		project: string;
		status: string;
		priority?: string | null;
		reporter?: string | null;
		updated: string | null;
	}[];
	pulls: {
		url: string;
		title: string;
		repo: string;
		number: number;
		author: string;
		updated: string | null;
	}[];
	notion: {
		pageId: string;
		title: string;
		pageUrl: string;
		status: string | null;
		assignee: string | null;
		priority?: string | null;
		channel?: string | null;
		updatedAt: string | null;
		date: string | null;
	}[];
}): AllItem[] {
	return [
		...input.tasks.map(
			(task): AllItem => ({
				key: `task:${task.id}`,
				source: "Tasks",
				to: "/my-tasks",
				title: task.title,
				url: null,
				person: null,
				status: null,
				context: null,
				priority: PRIORITY_LABELS[priorityOf(task)],
				at: task.createdAt,
			}),
		),
		...input.slack
			.filter((row) => row.status === "Not started")
			.map(
				(row): AllItem => ({
					key: `slack:${row.id}`,
					source: "Slack",
					to: "/reactions",
					title: row.title,
					url: row.permalink,
					person: row.authorName,
					status: null,
					priority: null,
					context: row.channelName && `#${row.channelName}`,
					at: ms(row.postedAt),
				}),
			),
		...input.jira.map(
			(issue): AllItem => ({
				key: `jira:${issue.key}`,
				source: "Jira",
				to: "/jira",
				title: `${issue.key}: ${issue.title}`,
				url: issue.url,
				person: issue.reporter ?? null,
				status: issue.status,
				priority: issue.priority ?? null,
				context: issue.project,
				at: ms(issue.updated),
			}),
		),
		...input.pulls
			.filter((pull) => !isBot(pull.author))
			.map(
				(pull): AllItem => ({
					key: `pr:${pull.url}`,
					source: "GitHub",
					to: "/prs",
					title: `${pull.repo}#${pull.number}: ${pull.title}`,
					url: pull.url,
					person: pull.author,
					status: null,
					priority: null,
					// Every repo is the same org — the column is for the repo name.
					context: pull.repo.split("/").at(-1) ?? pull.repo,
					at: ms(pull.updated),
				}),
			),
		...input.notion.map(
			(row): AllItem => ({
				key: `notion:${row.pageId}`,
				source: "Notion",
				to: "/notion",
				title: row.title,
				url: row.pageUrl,
				person: row.assignee,
				status: row.status,
				priority: row.priority ?? null,
				context: row.channel ?? null,
				at: ms(row.updatedAt ?? row.date),
			}),
		),
	].sort((a, b) => b.at - a.at);
}
