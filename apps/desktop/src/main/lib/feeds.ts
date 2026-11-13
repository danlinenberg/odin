import { TRPCError } from "@trpc/server";
import {
	type NotionPage,
	normalizePage,
	type SlackQueueRow,
} from "./notion-page";

/**
 * The work feeds Next in line is built from (Jira, GitHub, ClickUp, Notion), as
 * plain functions over a `call`: this computer passes one that fetches the
 * API with its own token (lib/trpc/routers/work), and the phone server on a
 * remote host one that goes through the host's service (phone/host/feeds),
 * which holds the tokens there. Same rows either way. No Electron here: the
 * phone server is bundled from this.
 */

/** A GET (or the given method) on `path`, relative to the source's API root. */
export type FeedCall = (
	path: string,
	init?: { method?: string; body?: string },
) => Promise<Response>;

/**
 * Whether a Jira project + issue type's screen has a Due date field, by
 * `base|project|issueType`. Screens change rarely; a restart re-asks.
 */
const dueOnScreen = new Map<string, Promise<boolean>>();

/**
 * The Sprint field's id on each Jira site, by base URL. It's a custom field
 * (customfield_10020 on most sites, not all), so it's found by its type once.
 */
const sprintFieldBySite = new Map<string, Promise<string | null>>();

interface JiraSprintValue {
	name?: string;
	state?: string;
	startDate?: string;
	endDate?: string;
}

/**
 * The sprint a ticket sits in the way Jira's backlog shows it: the active
 * one, else the next one coming, else none - an open ticket whose sprints
 * have all closed is back in the Backlog.
 */
export function currentSprint(value: unknown): JiraIssueRow["sprint"] {
	if (!Array.isArray(value)) return null;
	const sprints = (value as JiraSprintValue[]).filter((s) => s?.name);
	const pick =
		sprints.find((s) => s.state === "active") ??
		sprints
			.filter((s) => s.state === "future")
			.sort((a, b) =>
				(a.startDate ?? "~").localeCompare(b.startDate ?? "~"),
			)[0];
	if (!pick?.name) return null;
	return {
		name: pick.name,
		state: pick.state === "active" ? "active" : "future",
		startDate: pick.startDate ?? null,
		endDate: pick.endDate ?? null,
	};
}

/**
 * A feed request that failed. A dead credential is the common case - GitHub
 * OAuth tokens get revoked, Jira tokens expire - so it gets UNAUTHORIZED and
 * the fix, which the panes turn into a "Reconnect" button, instead of dumping
 * the raw API body in the pane. GitHub also spends 403 on rate limits, so that
 * one only counts as auth when the body doesn't say otherwise.
 */
export function feedError(
	provider: string,
	status: number,
	body: string,
): TRPCError {
	const isAuth =
		status === 401 || (status === 403 && !/rate limit/i.test(body));
	return new TRPCError({
		code: isAuth ? "UNAUTHORIZED" : "BAD_REQUEST",
		message: isAuth
			? `${provider} rejected the credentials (${status}) - reconnect ${provider} in Settings → Connections.`
			: `${provider} search failed (${status}): ${body.slice(0, 300)}`,
	});
}

/** The comment that @-mentioned me, flattened for a one-line preview. */
export interface JiraMention {
	author: string | null;
	at: string | null;
	text: string;
}

export interface JiraIssueRow {
	key: string;
	url: string;
	title: string;
	status: string;
	statusCategory: string;
	priority: string | null;
	project: string;
	issueType: string | null;
	reporter: string | null;
	updated: string | null;
	/** When the ticket was filed. */
	created?: string | null;
	/** Jira's own Due Date, `YYYY-MM-DD`. Null on the tickets nobody dated. */
	dueDate: string | null;
	/** Why it's in my list: assigned to me, filed by me, or a comment @s me. */
	role: "assigned" | "reported" | "mentioned";
	/** What was said to me, on the rows that are here because of a mention. */
	mention: JiraMention | null;
	/** The ticket's description as plain text, capped - for the hover card. */
	description?: string | null;
	/** The epic it sits under. Null when it has none, or its parent is a story. */
	epic?: { key: string; title: string } | null;
	/** The sprint it's in on Jira's board; null = the Backlog. */
	sprint?: {
		name: string;
		state: "active" | "future";
		startDate: string | null;
		endDate: string | null;
	} | null;
}

interface JiraParent {
	key: string;
	fields?: {
		summary?: string;
		issuetype?: { name?: string; hierarchyLevel?: number };
	};
}

/**
 * The parent, when it's an epic. A sub-task's parent is a story, not an epic;
 * hierarchy level 1 is the epic level whatever the site renamed the type to.
 */
export function epicOf(parent: JiraParent | undefined): JiraIssueRow["epic"] {
	const type = parent?.fields?.issuetype;
	if (
		!parent ||
		!(type?.hierarchyLevel === 1 || /epic/i.test(type?.name ?? ""))
	)
		return null;
	return { key: parent.key, title: parent.fields?.summary ?? parent.key };
}

export interface JiraComment {
	author?: { displayName?: string; accountId?: string };
	created?: string;
	body?: unknown;
}

/**
 * A comment body is ADF, not text. Flattened to one line for the feed: text
 * nodes as themselves, a mention as the "@Name" Jira already stored on it,
 * breaks as spaces - or as `br`, when the line breaks are worth keeping.
 */
export function adfToText(node: unknown, br = " "): string {
	if (!node || typeof node !== "object") return "";
	const adf = node as {
		type?: string;
		text?: string;
		attrs?: { text?: string };
		content?: unknown[];
	};
	if (adf.type === "mention") return adf.attrs?.text ?? "";
	if (adf.type === "text") return adf.text ?? "";
	const inner = (adf.content ?? [])
		.map((child) => adfToText(child, br))
		.join("");
	return adf.type === "paragraph" ||
		adf.type === "hardBreak" ||
		(br !== " " && (adf.type === "heading" || adf.type === "listItem"))
		? `${inner}${br}`
		: inner;
}

/**
 * The last thing someone said to me on a ticket - newest first, because that
 * is the one waiting on an answer. A mention stores my account id in the body,
 * so containing it anywhere is the whole test.
 */
export function latestMention(
	comments: JiraComment[],
	accountId: string,
): JiraMention | null {
	for (const comment of [...comments].reverse()) {
		if (!JSON.stringify(comment.body ?? null).includes(accountId)) continue;
		return {
			author: comment.author?.displayName ?? null,
			at: comment.created ?? null,
			text: adfToText(comment.body).replace(/\s+/g, " ").trim().slice(0, 1000),
		};
	}
	return null;
}

export interface PullRequestRow {
	id: number;
	number: number;
	url: string;
	title: string;
	repo: string;
	author: string;
	/** "mine" = I opened it; "review" = my review was requested; "mentioned" =
	 * someone @-named me on it (issues as well as PRs). */
	kind: "mine" | "review" | "mentioned";
	draft: boolean;
	updated: string | null;
	/** When the PR was opened. */
	created?: string | null;
	comments: number;
	/** The PR or issue body, markdown as written, capped. */
	body?: string | null;
}

/** One open ClickUp task assigned to me. */
export interface ClickupTaskRow {
	id: string;
	url: string;
	name: string;
	status: string | null;
	priority: string | null;
	list: string | null;
	creator: string | null;
	description: string | null;
	updated: string | null;
	created: string | null;
	dueDate: string | null;
}

/** ClickUp dates are epoch-ms strings; the feeds speak ISO. */
export const clickupDate = (ms: string | null | undefined) =>
	ms ? new Date(Number(ms)).toISOString() : null;

export interface JiraSearchResponse {
	issues?: {
		key: string;
		fields?: {
			summary?: string;
			status?: { name?: string; statusCategory?: { name?: string } };
			priority?: { name?: string };
			project?: { key?: string; name?: string };
			issuetype?: { name?: string };
			reporter?: { displayName?: string };
			updated?: string;
			created?: string;
			duedate?: string;
			comment?: { comments?: JiraComment[] };
			description?: unknown;
			parent?: JiraParent;
			[custom: string]: unknown;
		};
	}[];
}

export interface GithubSearchResponse {
	items?: {
		id: number;
		number: number;
		title: string;
		html_url: string;
		draft?: boolean;
		updated_at?: string;
		created_at?: string;
		comments?: number;
		user?: { login?: string };
		repository_url?: string;
		body?: string | null;
		closed_at?: string | null;
		pull_request?: { merged_at?: string | null };
	}[];
}

/** My open Jira issues: assigned to me, filed by me, or a comment that names me. */
export async function jiraIssues(
	call: FeedCall,
	/** The API root `call` resolves against: the caches are per site. */
	base: string,
	/** The site's own address, for the issue links. */
	siteUrl: string,
	includeDone = false,
): Promise<JiraIssueRow[]> {
	const openOnly = includeDone ? "" : " AND statusCategory != Done";
	// Who currentUser() resolved to, so the mention rows can point at
	// the comment that named me. Started here rather than awaited, so
	// it rides alongside the searches instead of delaying them.
	const myAccountId = call("rest/api/3/myself")
		.then(async (response) =>
			response.ok
				? ((await response.json()) as { accountId?: string }).accountId
				: null,
		)
		.catch(() => null);

	let sprintFieldRequest = sprintFieldBySite.get(base);
	if (!sprintFieldRequest) {
		sprintFieldRequest = call("rest/api/3/field")
			.then(async (response) => {
				if (!response.ok) return null;
				const fields = (await response.json()) as {
					id: string;
					schema?: { custom?: string };
				}[];
				return (
					fields.find(
						(field) =>
							field.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint",
					)?.id ?? null
				);
			})
			.catch(() => null);
		sprintFieldBySite.set(base, sprintFieldRequest);
	}
	const sprintField = await sprintFieldRequest;

	const search = async (
		role: JiraIssueRow["role"],
		match: string,
	): Promise<JiraIssueRow[]> => {
		const jql = `${match}${openOnly} ORDER BY updated DESC`;
		// Comment bodies are only worth their weight on the mention rows,
		// where they are the point.
		const fields = `summary,status,priority,project,issuetype,reporter,assignee,updated,created,duedate,description,parent${sprintField ? `,${sprintField}` : ""}${role === "mentioned" ? ",comment" : ""}`;
		const response = await call(
			`rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${fields}`,
		);
		if (!response.ok) {
			throw feedError("Jira", response.status, await response.text());
		}
		const payload = (await response.json()) as JiraSearchResponse;
		const accountId = role === "mentioned" ? await myAccountId : null;
		const rows = (payload.issues ?? []).map((issue) => ({
			key: issue.key,
			url: `${siteUrl}/browse/${issue.key}`,
			title: issue.fields?.summary ?? "(no summary)",
			status: issue.fields?.status?.name ?? "Unknown",
			statusCategory: issue.fields?.status?.statusCategory?.name ?? "Unknown",
			priority: issue.fields?.priority?.name ?? null,
			project:
				issue.fields?.project?.name ??
				issue.fields?.project?.key ??
				issue.key.split("-")[0],
			issueType: issue.fields?.issuetype?.name ?? null,
			reporter: issue.fields?.reporter?.displayName ?? null,
			updated: issue.fields?.updated ?? null,
			created: issue.fields?.created ?? null,
			dueDate: issue.fields?.duedate ?? null,
			role,
			description:
				adfToText(issue.fields?.description, "\n")
					.replace(/\n{3,}/g, "\n\n")
					.trim()
					.slice(0, 3000) || null,
			epic: epicOf(issue.fields?.parent),
			sprint: sprintField ? currentSprint(issue.fields?.[sprintField]) : null,
			mention: accountId
				? latestMention(issue.fields?.comment?.comments ?? [], accountId)
				: null,
		}));
		// Jira indexes a comment's author along with its body, so
		// `comment ~ currentUser()` also returns tickets I merely
		// commented on. Only the ones that actually name me belong here.
		return role === "mentioned" ? rows.filter((row) => row.mention) : rows;
	};

	const [assigned, reported, mentioned] = await Promise.all([
		search("assigned", "assignee = currentUser()"),
		search("reported", "reporter = currentUser()"),
		// An @-mention embeds my account id in the comment body, and
		// currentUser() resolves to that id - so a text match on
		// `comment` is what finds "someone tagged me here".
		search("mentioned", "comment ~ currentUser()"),
	]);
	// An issue can come back from several searches; the first claim
	// wins, strongest first - assigned, then filed, then mentioned. The
	// mention rides along on the winner: it's what brings a ticket I put
	// away with Done back when someone asks me something on it.
	const mentions = new Map(mentioned.map((row) => [row.key, row.mention]));
	const seen = new Set<string>();
	const issues: JiraIssueRow[] = [];
	for (const issue of [...assigned, ...reported, ...mentioned]) {
		if (seen.has(issue.key)) continue;
		seen.add(issue.key);
		issues.push({ ...issue, mention: mentions.get(issue.key) ?? null });
	}
	// A due date Jira keeps but doesn't show: an issue type whose
	// screen has no Due date field still returns the stored value (an
	// epic created with one, say). Only a date you can see in Jira
	// counts. The screen is per project and issue type, so one editmeta
	// call per pair; a failed check keeps the date.
	await Promise.all(
		issues
			.filter((issue) => issue.dueDate)
			.map(async (issue) => {
				const screen = `${base}|${issue.project}|${issue.issueType}`;
				let shown = dueOnScreen.get(screen);
				if (!shown) {
					shown = call(`rest/api/3/issue/${issue.key}/editmeta`)
						.then(async (response) =>
							response.ok
								? "duedate" in
									(((await response.json()) as { fields?: object }).fields ??
										{})
								: true,
						)
						.catch(() => true);
					dueOnScreen.set(screen, shown);
				}
				if (!(await shown)) issue.dueDate = null;
			}),
	);
	return issues;
}

/** Open PRs and issues I wrote, was asked to review, or am named on. */
export async function pullRequests(call: FeedCall): Promise<PullRequestRow[]> {
	const search = async (
		q: string,
		kind: PullRequestRow["kind"],
	): Promise<PullRequestRow[]> => {
		const response = await call(
			`search/issues?q=${encodeURIComponent(q)}&per_page=50&sort=updated`,
		);
		if (!response.ok) {
			throw feedError("GitHub", response.status, await response.text());
		}
		const payload = (await response.json()) as GithubSearchResponse;
		return (payload.items ?? []).map((item) => ({
			id: item.id,
			number: item.number,
			url: item.html_url,
			title: item.title,
			// repository_url looks like https://api.github.com/repos/<owner>/<repo>
			repo: (item.repository_url ?? "").split("/repos/")[1] ?? "",
			author: item.user?.login ?? "",
			kind,
			draft: item.draft ?? false,
			updated: item.updated_at ?? null,
			created: item.created_at ?? null,
			comments: item.comments ?? 0,
			body: item.body?.trim().slice(0, 3000) || null,
		}));
	};
	const [mine, review, mentioned] = await Promise.all([
		search("is:open is:pr author:@me archived:false", "mine"),
		search("is:open is:pr review-requested:@me archived:false", "review"),
		// No `is:pr`: a mention on an issue is the same ask as one on a
		// PR, and dropping it would leave the tab half-empty.
		search("is:open mentions:@me archived:false", "mentioned"),
	]);
	// A thread can match several searches; the first claim wins,
	// strongest first - mine, then my review, then merely named.
	const seen = new Set<number>();
	const pulls: PullRequestRow[] = [];
	for (const pull of [...mine, ...review, ...mentioned]) {
		if (seen.has(pull.id)) continue;
		seen.add(pull.id);
		pulls.push(pull);
	}
	return pulls;
}

/** The open ClickUp tasks assigned to me, across my workspaces. */
export async function clickupTasks(call: FeedCall): Promise<ClickupTaskRow[]> {
	const get = async <T>(path: string): Promise<T> => {
		const response = await call(path);
		if (!response.ok) {
			throw feedError("ClickUp", response.status, await response.text());
		}
		return (await response.json()) as T;
	};
	const [{ user }, { teams }] = await Promise.all([
		get<{ user: { id: number } }>("user"),
		get<{ teams: { id: string }[] }>("team"),
	]);
	type Task = {
		id: string;
		name: string;
		url: string;
		status?: { status?: string };
		priority?: { priority?: string } | null;
		list?: { name?: string };
		creator?: { username?: string };
		text_content?: string | null;
		date_updated?: string | null;
		date_created?: string | null;
		due_date?: string | null;
	};
	const pages = await Promise.all(
		teams.map((team) =>
			get<{ tasks: Task[] }>(
				`team/${team.id}/task?assignees[]=${user.id}&subtasks=true&order_by=updated`,
			),
		),
	);
	return pages
		.flatMap((page) => page.tasks)
		.map((task) => ({
			id: task.id,
			url: task.url,
			name: task.name,
			status: task.status?.status ?? null,
			priority: task.priority?.priority ?? null,
			list: task.list?.name ?? null,
			creator: task.creator?.username ?? null,
			description: task.text_content || null,
			updated: clickupDate(task.date_updated),
			created: clickupDate(task.date_created),
			dueDate: clickupDate(task.due_date),
		}));
}

/** Every page of a Notion database, newest first (capped at 1000), and the database itself. */
export async function notionDatabase(
	call: FeedCall,
	databaseId: string,
): Promise<{
	pages: SlackQueueRow[];
	dbPayload: { title?: { plain_text?: string }[] } | null;
}> {
	// Every row, no filter - the view tabs/groups client-side. Paginate
	// past Notion's 100-row page cap (cap total so a huge DB can't hang).
	const results: NotionPage[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 10; page++) {
		const queryResponse = await call(`databases/${databaseId}/query`, {
			method: "POST",
			body: JSON.stringify({
				page_size: 100,
				...(cursor ? { start_cursor: cursor } : {}),
				sorts: [{ timestamp: "created_time", direction: "descending" }],
			}),
		});
		if (!queryResponse.ok) {
			const body = await queryResponse.text();
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Notion query failed (${queryResponse.status}): ${body.slice(0, 300)}`,
			});
		}
		const payload = (await queryResponse.json()) as {
			results?: NotionPage[];
			has_more?: boolean;
			next_cursor?: string | null;
		};
		results.push(...(payload.results ?? []));
		if (!payload.has_more || !payload.next_cursor) break;
		cursor = payload.next_cursor;
	}
	const dbResponse = await call(`databases/${databaseId}`);
	return {
		pages: results.filter((page) => page.object === "page").map(normalizePage),
		dbPayload: dbResponse.ok
			? ((await dbResponse.json()) as { title?: { plain_text?: string }[] })
			: null,
	};
}
