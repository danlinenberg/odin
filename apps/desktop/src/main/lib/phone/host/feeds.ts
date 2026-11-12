import { renameSync, writeFileSync } from "node:fs";
import {
	pickEyedMessages,
	type SlackReactionsListItem,
} from "lib/trpc/routers/slack/reactions";
import {
	type AllItem,
	allItems,
} from "renderer/routes/_authenticated/_odin/all/all-items";
import { doneChecker } from "renderer/stores/done-check";
import {
	clickupTasks,
	type FeedCall,
	jiraIssues,
	notionDatabase,
	pullRequests,
} from "../../feeds";
import { hostPorts } from "../../remote-host/host-service";
import { hostPaths, readAway } from "./sessions";

/**
 * The full board on the remote host (Tasks with the Mac closed): the host
 * fetches Slack, Jira, GitHub, Notion and ClickUp itself, through its own
 * service (remote-host/host-service), which holds the tokens - this process
 * never sees one. The rows are the Mac's (allItems, the same rules), less what
 * you marked Done there, so the phone lists what arrived while the Mac slept
 * and Start runs one on the host.
 */

/** What the Mac sends with the list (remote-host/away) for the host to fetch with. */
export interface HostFeeds {
	/** The Slack reaction that queues a message, as Settings has it. */
	slackReaction: string;
	/** The Jira site's own address, for the issue links; none = no Jira. */
	jiraSiteUrl: string | null;
	/** The Notion database of the Tasks view; none = no Notion. */
	notionDatabaseId: string | null;
}

/** Done on the Mac, by row key: enough for doneChecker. */
export type HostDone = Record<string, { at: number; url: string | null }>;

/** An API call through the host service, as a Response the feeds read. */
export function serviceCall(
	service: "slack" | "jira" | "github" | "notion" | "clickup",
	post = (form: URLSearchParams) =>
		fetch(
			`http://127.0.0.1:${hostPorts(process.getuid?.() ?? 0).service}/odin`,
			{
				method: "POST",
				body: form,
				signal: AbortSignal.timeout(60_000),
			},
		).then((response) => response.text()),
): FeedCall {
	return async (path, init) => {
		const form = new URLSearchParams({ action: "service", service, path });
		if (init?.method) form.set("method", init.method);
		if (init?.body) form.set("body", init.body);
		// The service answers "HTTP <status>" and the body, or a line saying
		// why it couldn't call (the connector is off on the host, say).
		const text = await post(form);
		const head = /^HTTP (\d{3})\n/.exec(text);
		return head
			? new Response(text.slice(head[0].length), { status: Number(head[1]) })
			: new Response(text, { status: 503 });
	};
}

/** The Slack messages I queued with the reaction: the Mac's rows, without its database. */
export async function slackRows(call: FeedCall, reaction: string) {
	const json = async <T>(path: string): Promise<T> => {
		const body = (await (await call(path)).json()) as T & {
			ok?: boolean;
			error?: string;
		};
		if (!body.ok) throw new Error(`Slack ${path}: ${body.error ?? "failed"}`);
		return body;
	};
	const me = await json<{ user_id: string }>("auth.test");
	const { items } = await json<{ items?: SlackReactionsListItem[] }>(
		`reactions.list?user=${me.user_id}&limit=100&full=true`,
	);
	return pickEyedMessages(items ?? [], me.user_id, reaction).map((message) => {
		const postedAt = new Date(Number(message.messageTs) * 1000).toISOString();
		return {
			id: message.id,
			title:
				message.text.split("\n")[0].trim().slice(0, 120) || "Slack message",
			text: message.text,
			status: "Not started",
			permalink: message.permalink,
			channelName: null,
			authorName: null,
			postedAt,
		};
	});
}

/** Every source at once; one that fails (signed out on the host, say) is left out. */
export async function hostBoard(
	feeds: HostFeeds,
	done: HostDone,
	call: typeof serviceCall = serviceCall,
): Promise<AllItem[]> {
	const quiet = <T>(what: string, run: () => Promise<T[]>) =>
		run().catch((error) => {
			console.warn(`[host board] ${what}:`, String(error).slice(0, 300));
			return [] as T[];
		});
	const [slack, jira, pulls, notion, clickup] = await Promise.all([
		quiet("Slack", () => slackRows(call("slack"), feeds.slackReaction)),
		feeds.jiraSiteUrl
			? quiet("Jira", () =>
					jiraIssues(call("jira"), "host", feeds.jiraSiteUrl as string),
				)
			: [],
		quiet("GitHub", () => pullRequests(call("github"))),
		feeds.notionDatabaseId
			? quiet(
					"Notion",
					async () =>
						(
							await notionDatabase(
								call("notion"),
								feeds.notionDatabaseId as string,
							)
						).pages,
				)
			: [],
		quiet("ClickUp", () => clickupTasks(call("clickup"))),
	]);
	const isDone = doneChecker(
		Object.fromEntries(
			Object.entries(done).map(([key, row]) => [
				key,
				{ ...row, title: "", source: "" },
			]),
		),
	);
	return allItems({ tasks: [], slack, jira, pulls, notion, clickup }).filter(
		(item) => !isDone(item),
	);
}

/** Where the board's rows wait for the runner's `start <key>` (night.ts). */
export const boardFile = () => `${hostPaths.home}/.odin/night/board.json`;

/** What Start needs of a row: its title and what the session reads. */
export interface BoardRow {
	key: string;
	title: string;
	text: string;
}

export const boardRow = (item: AllItem): BoardRow => ({
	key: item.key,
	title: item.title,
	text: [item.launch.title, item.launch.description]
		.filter(Boolean)
		.join("\n\n"),
});

/** Keeps the rows for the runner, readable by this user alone. */
export function saveBoard(rows: BoardRow[]): void {
	const path = boardFile();
	writeFileSync(`${path}.new`, JSON.stringify(rows), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}

/** How long the host's board stands before the next fetch: the Mac's poll. */
const FRESH_MS = 120_000;
let latest: { at: number; rows: BoardRow[] } | null = null;
let fetching: Promise<void> | null = null;

/**
 * The host's board rows, fetched at most every two minutes. The first ask
 * waits up to 8 seconds for the fetch; after that the phone gets the last rows at once and
 * a newer fetch runs behind them. None while the laptop's list says nothing
 * about the feeds (an older laptop) or expired.
 */
export async function hostRows(now = Date.now()): Promise<BoardRow[]> {
	const away = readAway(now);
	if (!away?.feeds) return [];
	const { feeds, done = {} } = away;
	if (!latest || now - latest.at > FRESH_MS)
		fetching ??= hostBoard(feeds, done)
			.then((items) => {
				const rows = items.map(boardRow);
				saveBoard(rows);
				latest = { at: Date.now(), rows };
			})
			.catch((error) => console.warn("[host board]", error))
			.finally(() => {
				fetching = null;
			});
	// The first ask waits a little, not for a slow source: the rest come on the next look.
	if (!latest)
		await Promise.race([
			fetching,
			new Promise((done) => setTimeout(done, 8_000)),
		]);
	return latest?.rows ?? [];
}
