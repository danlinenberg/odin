import {
	readOdinConfig,
	resolveNotionToken,
} from "lib/trpc/routers/odin-config";
import { slackFile, slackThreadText } from "lib/trpc/routers/slack";
import { githubAccessToken, githubApiFetch } from "./github-token";
import { jiraRequestContext } from "./jira-token";
import { linkKind } from "./link-kind";

/**
 * A Slack, Jira, GitHub, Notion or ClickUp link read as plain text with Odin's own
 * connection - so a session never depends on which MCP servers happen to be
 * connected on this machine. Served at /read (notifications/server.ts).
 *
 * Throws with a reason a session can act on: not connected, or the provider
 * said no. Gmail has no reader: Odin holds only the feed, and the session's
 * prompt already carries the subject and snippet.
 */
export async function readLink(url: string): Promise<string> {
	const link = linkKind(url);
	switch (link?.kind) {
		case "slack": {
			const text = await slackThreadText(link.url);
			if (!text)
				throw new Error(
					// Tokens from before v1.0.10 lack the *:history scopes.
					"Odin couldn't read that thread. Reconnect Slack in Odin's Settings > Connections to grant read access, then retry.",
				);
			return text;
		}
		case "github":
			return readGithub(link.repo, link.number);
		case "jira":
			return readJira(link.key);
		case "notion":
			return readNotion(link.id);
		case "clickup":
			return readClickup(link.id, link.teamId);
		default:
			throw new Error(
				"Odin can't read that link: not a Slack, Jira, GitHub, Notion or ClickUp one.",
			);
	}
}

/** The /file command a session downloads a listed attachment with. */
export const fileCommand = (url: string) =>
	`curl -sfG "http://127.0.0.1:$ODIN_PORT/file" --data-urlencode "url=${url}" -o <path>`;

/**
 * A file a /read listed - a Slack upload or a Jira attachment - fetched with
 * Odin's token for it. Each token only ever goes to its own provider's host,
 * whatever the url says. Null when Odin can't: not connected, or no access.
 */
export async function fetchFile(url: string): Promise<Response | null> {
	if (new URL(url).hostname === "files.slack.com") return slackFile(url);
	const jira = /\/rest\/api\/3\/attachment\/content\/(\d+)/.exec(url);
	if (!jira) return null;
	const ctx = await jiraRequestContext();
	if (!ctx) return null;
	const res = await fetch(
		`${ctx.base}/rest/api/3/attachment/content/${jira[1]}`,
		{ headers: { Authorization: ctx.authorization } },
	);
	return res.ok ? res : null;
}

const stripHtml = (html: string | null | undefined) =>
	(html ?? "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();

async function readJira(key: string): Promise<string> {
	const ctx = await jiraRequestContext();
	if (!ctx) throw new Error("Jira isn't connected in Odin.");
	const res = await fetch(
		`${ctx.base}/rest/api/3/issue/${key}?expand=renderedFields&fields=summary,status,assignee,reporter,issuelinks,attachment,description,comment`,
		{
			headers: { Authorization: ctx.authorization, Accept: "application/json" },
		},
	);
	if (!res.ok) throw new Error(`Jira answered ${res.status} for ${key}.`);
	type Comment = {
		author?: { displayName?: string };
		body?: string;
		created?: string;
	};
	const issue = (await res.json()) as {
		fields: {
			summary?: string;
			status?: { name?: string };
			assignee?: { displayName?: string } | null;
			reporter?: { displayName?: string } | null;
			issuelinks?: {
				type?: { outward?: string };
				outwardIssue?: { key?: string };
				inwardIssue?: { key?: string };
			}[];
			attachment?: { filename?: string; content?: string }[];
		};
		renderedFields: {
			description?: string;
			comment?: { comments?: Comment[] };
		};
	};
	const { fields, renderedFields } = issue;
	return [
		`${key}: ${fields.summary ?? ""}`,
		`Status: ${fields.status?.name ?? "?"} · Assignee: ${fields.assignee?.displayName ?? "none"} · Reporter: ${fields.reporter?.displayName ?? "?"}`,
		"",
		"Description:",
		stripHtml(renderedFields.description) || "(empty)",
		...(fields.issuelinks?.length
			? [
					"",
					"Links:",
					...fields.issuelinks.map(
						(l) =>
							`- ${l.type?.outward ?? "relates"} ${l.outwardIssue?.key ?? l.inwardIssue?.key ?? ""}`,
					),
				]
			: []),
		...(fields.attachment?.length
			? [
					"",
					"Attachments:",
					...fields.attachment.map(
						(a) =>
							`- ${a.filename}: ${a.content ? fileCommand(a.content) : "(no link)"}`,
					),
				]
			: []),
		"",
		"Comments:",
		...(renderedFields.comment?.comments ?? []).map(
			(c) =>
				`- ${c.author?.displayName ?? "someone"} (${c.created ?? ""}): ${stripHtml(c.body)}`,
		),
	].join("\n");
}

async function readGithub(repo: string, number: string): Promise<string> {
	const token = await githubAccessToken();
	if (!token) throw new Error("GitHub isn't connected in Odin.");
	const api = (path: string, accept = "application/vnd.github+json") =>
		githubApiFetch(
			`https://api.github.com/repos/${repo}/${path}`,
			{ headers: { Accept: accept } },
			token,
		);
	const res = await api(`issues/${number}`);
	if (!res.ok)
		throw new Error(`GitHub answered ${res.status} for ${repo}#${number}.`);
	type Comment = {
		user?: { login?: string };
		body?: string | null;
		path?: string;
		line?: number;
	};
	const issue = (await res.json()) as {
		title?: string;
		state?: string;
		user?: { login?: string };
		body?: string | null;
		pull_request?: unknown;
	};
	const comments = (await (
		await api(`issues/${number}/comments?per_page=100`)
	).json()) as Comment[];
	const lines = [
		`${repo}#${number}: ${issue.title ?? ""} (${issue.state ?? "?"}, by ${issue.user?.login ?? "?"})`,
		"",
		issue.body ?? "(no description)",
		"",
		"Comments:",
		...comments.map((c) => `- ${c.user?.login ?? "?"}: ${c.body ?? ""}`),
	];
	if (issue.pull_request) {
		const review = (await (
			await api(`pulls/${number}/comments?per_page=100`)
		).json()) as Comment[];
		const diff = await (
			await api(`pulls/${number}`, "application/vnd.github.diff")
		).text();
		lines.push(
			"",
			"Review comments:",
			...review.map(
				(c) =>
					`- ${c.user?.login ?? "?"} on ${c.path}:${c.line ?? "?"}: ${c.body ?? ""}`,
			),
			"",
			"Diff:",
			diff,
		);
	}
	return lines.join("\n");
}

/** ClickUp's v2 API, with the personal token Settings → Connections saved. */
export function clickupFetch(path: string, token: string): Promise<Response> {
	return fetch(`https://api.clickup.com/api/v2/${path}`, {
		headers: { Authorization: token },
	});
}

async function readClickup(id: string, teamId?: string): Promise<string> {
	const token = readOdinConfig().clickupToken;
	if (!token) throw new Error("ClickUp isn't connected in Odin.");
	// A custom id (DEV-42) only resolves with its workspace named.
	const custom = teamId ? `custom_task_ids=true&team_id=${teamId}` : "";
	const res = await clickupFetch(
		`task/${encodeURIComponent(id)}?include_subtasks=true&include_markdown_description=true&${custom}`,
		token,
	);
	if (!res.ok) throw new Error(`ClickUp answered ${res.status} for ${id}.`);
	type User = { username?: string } | null | undefined;
	const task = (await res.json()) as {
		name?: string;
		url?: string;
		status?: { status?: string };
		creator?: User;
		assignees?: User[];
		list?: { name?: string };
		markdown_description?: string;
		text_content?: string;
		subtasks?: { name?: string; status?: { status?: string } }[];
		attachments?: { title?: string; url?: string }[];
	};
	const commentsRes = await clickupFetch(
		`task/${encodeURIComponent(id)}/comment?${custom}`,
		token,
	);
	const { comments = [] } = commentsRes.ok
		? ((await commentsRes.json()) as {
				comments?: { comment_text?: string; user?: User; date?: string }[];
			})
		: {};
	const who = (u: User) => u?.username ?? "?";
	return [
		`ClickUp ${id}: ${task.name ?? ""} (${task.url ?? ""})`,
		`Status: ${task.status?.status ?? "?"} · List: ${task.list?.name ?? "?"} · Assignees: ${task.assignees?.map(who).join(", ") || "none"} · Creator: ${who(task.creator)}`,
		"",
		"Description:",
		task.markdown_description || task.text_content || "(empty)",
		...(task.subtasks?.length
			? [
					"",
					"Subtasks:",
					...task.subtasks.map(
						(t) => `- ${t.name ?? ""} (${t.status?.status ?? "?"})`,
					),
				]
			: []),
		...(task.attachments?.length
			? [
					"",
					"Attachments:",
					...task.attachments.map((a) => `- ${a.title ?? "file"}: ${a.url}`),
				]
			: []),
		"",
		"Comments:",
		...comments.map(
			(c) =>
				`- ${who(c.user)} (${c.date ? new Date(Number(c.date)).toISOString() : ""}): ${c.comment_text ?? ""}`,
		),
	].join("\n");
}

type RichText = { plain_text?: string }[];
const plain = (rich: RichText | undefined) =>
	(rich ?? []).map((t) => t.plain_text ?? "").join("");

/** ponytail: top-level blocks only; nested toggles/columns read as their first line. Recurse if pages need it. */
async function readNotion(id: string): Promise<string> {
	const token = resolveNotionToken();
	if (!token) throw new Error("Notion isn't connected in Odin.");
	const notion = async (path: string) => {
		const res = await fetch(`https://api.notion.com/v1/${path}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Notion-Version": "2022-06-28",
			},
		});
		if (!res.ok)
			throw new Error(
				`Notion answered ${res.status} - is this page shared with Odin's connection?`,
			);
		return res.json();
	};
	const page = (await notion(`pages/${id}`)) as {
		url?: string;
		properties?: Record<
			string,
			{
				type: string;
				title?: RichText;
				rich_text?: RichText;
				select?: { name?: string } | null;
				status?: { name?: string } | null;
				url?: string | null;
			}
		>;
	};
	const props = Object.entries(page.properties ?? {}).map(([name, p]) => {
		const value =
			plain(p.title) ||
			plain(p.rich_text) ||
			p.select?.name ||
			p.status?.name ||
			p.url ||
			"";
		return `- ${name}: ${value}`;
	});
	const lines = [
		`Notion page ${page.url ?? id}`,
		"",
		"Properties:",
		...props,
		"",
		"Body:",
	];
	let cursor: string | undefined;
	do {
		const batch = (await notion(
			`blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
		)) as {
			results: ({ type: string } & Record<
				string,
				{ rich_text?: RichText } | unknown
			>)[];
			next_cursor: string | null;
		};
		for (const block of batch.results) {
			const body = block[block.type] as
				| {
						rich_text?: RichText;
						file?: { url?: string };
						external?: { url?: string };
				  }
				| undefined;
			const text = plain(body?.rich_text);
			if (text) lines.push(text);
			// Images and files carry a signed link that needs no token (1h).
			const link = body?.file?.url ?? body?.external?.url;
			if (link) lines.push(`[${block.type}] curl -sf "${link}" -o <path>`);
		}
		cursor = batch.next_cursor ?? undefined;
	} while (cursor);
	return lines.join("\n");
}
