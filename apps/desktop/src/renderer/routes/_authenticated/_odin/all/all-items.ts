import type { OdinSource } from "renderer/hooks/useLaunchTaskSession";
import type { FeedPath } from "../components/feed-counts";
import { isBot } from "../components/feed-counts";
import { buildIssuePrompt, buildReviewPrompt } from "../feed-prompts";
import {
	type OdinTask,
	PRIORITY_LABELS,
	priorityOf,
	taskPrompt,
} from "../hooks/useOdinTasks";
import { buildRowPrompt, type NotionRow } from "../notion/rows";
import { buildThreadPrompt } from "../thread-prompt";

/**
 * Everything useLaunchTaskSession needs for a row except the workspace — so
 * All can start a session itself instead of sending you to the feed that
 * knows how. Built where the row is flattened, because that's the last place
 * the source's own fields (the Slack message text, the PR's kind, the Notion
 * page's properties) still exist.
 */
export interface AllLaunch {
	key: string;
	title: string;
	description: string | null;
	contact: string | null;
	brief: string;
	/** Slack/Notion only — the upstream page a pane is matched back to. */
	pageId?: string;
	/** Absent for my own tasks: they're not work anyone delegated. */
	source?: OdinSource;
	/** My own tasks only — the skill the session opens with. */
	skill?: string;
}

/**
 * One row of the All feed — a task from any source, flattened to the few
 * things every source has: a name, where it came from, where to open it.
 */
export interface AllItem {
	/** Unique across sources — two systems can hand out the same id. */
	key: string;
	source: "Tasks" | "Slack" | "Jira" | "GitHub" | "Notion" | "Email";
	/** The feed this row lives in — clicking the title goes there. */
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
	/** The same priority in terms every source shares, so one filter fits all. */
	urgency: Urgency;
	/** Sort key in ms. 0 when the source didn't date it. */
	at: number;
	/** The date the source itself wants it by — Jira's Due Date. Ours overrides it. */
	dueDate: string | null;
	/** The comment that put it here — Jira's @-mention rows. Null elsewhere. */
	mention: { author: string | null; text: string } | null;
	/** Whatever else the source knows that the card has no room for —
	 * label/value pairs for the hover card, in reading order. */
	details: [string, string][];
	/** What to hand `launch` when Start session is clicked on this row. */
	launch: AllLaunch;
}

/** Priority, in the three levels every source can be read as. */
export type Urgency = "high" | "medium" | "low" | null;

/**
 * Each source names priority its own way — Jira says Highest, Notion says P1,
 * my own tasks say High. One filter can only span them if they answer to the
 * same three words.
 */
export function urgencyOf(priority: string | null | undefined): Urgency {
	const p = (priority ?? "").toLowerCase();
	if (/highest|urgent|critical|blocker|\bhigh\b|\bp[01]\b/.test(p))
		return "high";
	if (/lowest|\blow\b|minor|trivial|\bp[3-9]\b/.test(p)) return "low";
	if (/medium|normal|major|\bp2\b/.test(p)) return "medium";
	return null;
}

/** ISO → ms, and 0 for "no date" so an undated row sinks instead of throwing. */
function ms(iso: string | null | undefined): number {
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(t) ? 0 : t;
}

/** A date as people read it, or null when there isn't one. */
function when(at: string | number | null | undefined): string | null {
	const t = typeof at === "number" ? at : ms(at);
	return t
		? new Date(t).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: null;
}

/** The pairs that have a value, each label once — an empty field isn't a fact. */
function facts(
	pairs: [string, string | null | undefined][],
): [string, string][] {
	const seen = new Set<string>();
	return pairs.filter((pair): pair is [string, string] => {
		const label = pair[0].toLowerCase();
		if (!pair[1]?.trim() || seen.has(label)) return false;
		seen.add(label);
		return true;
	});
}

/**
 * Every feed as one list, newest first.
 *
 * Same rules the tab badges use — Slack counts only un-started messages, PRs
 * drop the bots — so All holds exactly what the other tabs claim between them
 * rather than being a second, larger truth.
 */
export function allItems(input: {
	tasks: OdinTask[];
	slack: {
		id: string;
		title: string;
		text: string;
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
		dueDate?: string | null;
		mention?: { author: string | null; text: string } | null;
		issueType?: string | null;
		role?: string;
		created?: string | null;
	}[];
	pulls: {
		id: number;
		url: string;
		title: string;
		repo: string;
		number: number;
		author: string;
		kind: "review" | "mine" | "mentioned";
		updated: string | null;
		draft?: boolean;
		comments?: number;
		created?: string | null;
	}[];
	notion: (NotionRow & {
		pageId: string;
		title: string;
		pageUrl: string;
		status: string | null;
		assignee: string | null;
		priority?: string | null;
		channel?: string | null;
		updatedAt: string | null;
		date: string | null;
	})[];
	/** Unread inbox mail — optional, most callers predate it. */
	emails?: {
		id: string;
		url: string;
		subject: string;
		snippet: string;
		from: string | null;
		fromEmail?: string | null;
		at: string | null;
		junk?: boolean | null;
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
				urgency: urgencyOf(PRIORITY_LABELS[priorityOf(task)]),
				at: task.createdAt,
				dueDate: null,
				mention: null,
				details: facts([
					["Created", when(task.createdAt)],
					["Skill", task.skill],
				]),
				launch: {
					key: task.id,
					title: task.title,
					description: task.notes || null,
					contact: null,
					brief: taskPrompt(task),
					...(task.skill ? { skill: task.skill } : {}),
				},
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
					// A reaction is someone asking me directly — always High.
					priority: "High",
					urgency: "high",
					context: row.channelName,
					at: ms(row.postedAt),
					dueDate: null,
					mention: null,
					details: facts([
						["Channel", row.channelName],
						["From", row.authorName],
						["Posted", when(row.postedAt)],
					]),
					launch: {
						key: row.id,
						title: row.title,
						// A queued message always has a permalink; the empty string
						// only keeps the type honest, and the row can't start
						// without one (the page checks `url` first).
						description: buildThreadPrompt(
							row.permalink ?? "",
							row.title,
							row.text,
						),
						contact: row.authorName,
						brief: row.title,
						pageId: row.id,
						source: "reactions",
					},
				}),
			),
		...input.jira
			// Tickets I filed wait on someone else — they live on the Jira tab.
			.filter((issue) => issue.role !== "reported")
			.map(
				(issue): AllItem => ({
					key: `jira:${issue.key}`,
					source: "Jira",
					to: "/jira",
					title: `${issue.key}: ${issue.title}`,
					url: issue.url,
					person: issue.reporter ?? null,
					status: issue.status,
					// An @-mention is someone asking me directly — High, like a reaction.
					priority: issue.mention ? "High" : (issue.priority ?? null),
					urgency: issue.mention ? "high" : urgencyOf(issue.priority),
					context: issue.project,
					at: ms(issue.updated),
					dueDate: issue.dueDate ?? null,
					mention: issue.mention ?? null,
					details: facts([
						["Type", issue.issueType],
						["Status", issue.status],
						["Priority", issue.priority],
						["Why here", issue.role],
						["Reporter", issue.reporter],
						["Project", issue.project],
						["Created", when(issue.created)],
						["Updated", when(issue.updated)],
						["Due", issue.dueDate],
					]),
					launch: {
						key: issue.key,
						title: `${issue.key}: ${issue.title}`,
						description: buildIssuePrompt(issue.key, issue.url, issue.title),
						contact: issue.reporter ?? null,
						brief: `${issue.key}: ${issue.title}\n${issue.url}`,
						source: "jira",
					},
				}),
			),
		...input.pulls
			// Your own PRs aren't tasks to pick up — they live on the PRs tab.
			.filter((pull) => pull.kind !== "mine" && !isBot(pull.author))
			.map(
				(pull): AllItem => ({
					// The PRs feed hides under `pr:<id>` — same key here, so a row
					// dismissed in either place is dismissed in both.
					key: `pr:${pull.id}`,
					source: "GitHub",
					to: "/prs",
					title: `${pull.repo}#${pull.number}: ${pull.title}`,
					url: pull.url,
					person: pull.author,
					status: null,
					priority: null,
					urgency: null,
					// Every repo is the same org — the column is for the repo name.
					context: pull.repo.split("/").at(-1) ?? pull.repo,
					at: ms(pull.updated),
					dueDate: null,
					mention: null,
					details: facts([
						["Repo", pull.repo],
						["Author", pull.author],
						[
							"Why here",
							pull.kind === "review" ? "review requested" : pull.kind,
						],
						["Draft", pull.draft ? "yes" : null],
						["Comments", pull.comments ? String(pull.comments) : null],
						["Opened", when(pull.created)],
						["Updated", when(pull.updated)],
					]),
					launch: {
						key: pull.url,
						title: `${pull.repo}#${pull.number}: ${pull.title}`,
						description: buildReviewPrompt(
							pull.url,
							pull.title,
							pull.repo,
							pull.kind,
						),
						contact: pull.author,
						brief: `${pull.repo}#${pull.number}: ${pull.title}\n${pull.url}`,
						source: "pr",
					},
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
				urgency: urgencyOf(row.priority),
				context: row.channel ?? null,
				at: ms(row.updatedAt ?? row.date),
				dueDate: null,
				mention: null,
				// Every property the database has, as Notion names it.
				details: facts([
					["Status", row.status],
					...Object.entries(row.fields),
					["Updated", when(row.updatedAt)],
				]),
				launch: {
					key: row.pageId,
					title: row.title,
					description: buildRowPrompt(row),
					contact: row.assignee,
					brief: `${row.title}\n${row.pageUrl}`,
					pageId: row.pageId,
					source: "notion",
				},
			}),
		),
		// Junk (the model's call, plus calendar mail) stays in the Email tab behind "All".
		...(input.emails ?? [])
			.filter((email) => email.junk !== true)
			.map(
				(email): AllItem => ({
					key: `email:${email.id}`,
					source: "Email",
					to: "/email",
					title: email.subject,
					url: email.url,
					person: email.from,
					status: null,
					priority: null,
					urgency: null,
					context: null,
					at: ms(email.at),
					dueDate: null,
					mention: email.snippet
						? { author: email.from, text: email.snippet }
						: null,
					details: facts([
						["From", email.fromEmail ?? email.from],
						["Received", when(email.at)],
					]),
					launch: {
						key: email.id,
						title: email.subject,
						description: `Email from ${email.from ?? "unknown"}: ${email.subject}\n${email.snippet}\n${email.url}`,
						contact: email.from,
						brief: `${email.subject}\n${email.url}`,
					},
				}),
			),
	].sort((a, b) => b.at - a.at);
}
