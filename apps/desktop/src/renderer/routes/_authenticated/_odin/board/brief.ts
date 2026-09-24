/**
 * "What is this session about, and where is it at?" — derived from Claude's own
 * transcript, which is the only honest record. The card title is whatever was
 * typed at launch and the terminal is a wall of live chatter; neither tells you
 * what you walked in on.
 */

export interface BriefMessage {
	role: "user" | "assistant";
	text: string;
	at: string | null;
}

export interface SessionBrief {
	/** Your latest instruction, when the session has moved past the opening ask. */
	lastAsk: string | null;
	/** What the agent last said with something in it — the de-facto status. */
	latest: string | null;
	/** Prose turns (yours + Claude's); tool calls never counted. */
	turns: number;
	/** Timestamp of the last turn, ISO, when the transcript recorded one. */
	at: string | null;
}

/** Below this an assistant turn is an acknowledgement, not a status report. */
const SUBSTANTIVE = 80;

/**
 * Resume used to launch the agent with the literal prompt "continue", so in
 * older transcripts the newest turn is that — which says nothing about what
 * you asked for. Your real last instruction is the one before it.
 */
const RESUME_STUB = /^\s*continue\.?\s*$/i;

export function sessionBrief(messages: BriefMessage[]): SessionBrief {
	const users = messages.filter(
		(message) => message.role === "user" && !RESUME_STUB.test(message.text),
	);
	const assistants = messages.filter((message) => message.role === "assistant");
	// "Ok." / "Done." is the reply, but the report is the turn before it — walk
	// back to the last one that actually says something.
	const latest =
		[...assistants].reverse().find((m) => m.text.length >= SUBSTANTIVE) ??
		assistants[assistants.length - 1];
	return {
		lastAsk: users.length > 1 ? (users[users.length - 1]?.text ?? null) : null,
		latest: latest?.text ?? null,
		turns: messages.length,
		at: messages[messages.length - 1]?.at ?? null,
	};
}

/** Claude's transcript directory for a cwd: every "/" and "." becomes "-". */
export function projectSlug(cwd: string): string {
	return cwd.replace(/[/.]/g, "-");
}

export interface PullRequestLink {
	url: string;
	repo: string;
	number: number;
}

// Trailing ")" and "." are markdown and prose, never part of the URL.
const PR_URL =
	/https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)\/pull\/(\d+)(?![\w-])/g;

/**
 * Pull requests this session produced, most recent first. Read straight out of
 * the conversation — a session that opened a PR always ends up printing its URL,
 * and that link is the first thing you want when you come back to it.
 *
 * Most recent first because a long-running session can open a dozen (one deploy
 * session had 15), and the one you want is the one it just made.
 *
 * Claude's turns only. A PR you paste in yourself is the session's *input* —
 * "run it on this pr" — not its output, and listing it as one of the session's
 * PRs is a lie. Anything the session opened it also announces, so nothing real
 * is lost; a PR you quoted that it worked on gets echoed back and still shows.
 */
export function pullRequests(messages: BriefMessage[]): PullRequestLink[] {
	const found = new Map<string, PullRequestLink>();
	for (const message of messages.filter((m) => m.role === "assistant")) {
		for (const [, repo, number] of message.text.matchAll(PR_URL)) {
			const url = `https://github.com/${repo}/pull/${number}`;
			// Keyed by url: the same PR is quoted many times in a session. First
			// mention wins, so a PR keeps the position where it was opened.
			if (!found.has(url))
				found.set(url, { url, repo, number: Number(number) });
		}
	}
	return [...found.values()].reverse();
}

export interface NotionPageLink {
	url: string;
	/** The 32-hex page id: the same page linked by slug and by /p/ is one page. */
	id: string;
	/** Recovered from the URL slug; a bare /p/<id> link carries none. */
	title: string | null;
}

// Every Notion host. ")" is excluded so a markdown [label](url) ends at the url.
const NOTION_URL =
	/https:\/\/(?:(?:www\.)?notion\.so|app\.notion\.com|[\w-]+\.notion\.site)\/[^\s)]+/g;
const NOTION_ID = /[0-9a-f]{32}/;

/** "…/Spot-Instances-…-<id>" — Notion puts the page title in the path. */
function slugTitle(url: string, id: string): string | null {
	const slug = url
		.split("?")[0]
		?.split("/")
		.pop()
		?.replace(new RegExp(`-?${id}$`), "");
	return slug
		? decodeURIComponent(slug).replace(/-+/g, " ").trim() || null
		: null;
}

// "[Backlog page](https://…" — the label of a markdown link, taken verbatim.
const MARKDOWN_LABEL = /\[([^\]\n]{1,80})\]\($/;
// "Backlog page — https://…" — a name and a separator at the end of the line.
const PROSE_LABEL =
	/(?:^|\n)\s*(?:[-*]\s+)?(?:\*\*)?([^\n]{1,80}?)(?:\*\*)?\s*[—:|·]\s*$/;

/**
 * What to call a page, given the text that introduced its url.
 *
 * The slug is the obvious source and is almost never there: every url the
 * Notion MCP hands back is a bare /p/<id>, so a session that published five
 * pages produced five links none of which could be named. The name is in the
 * prose instead — "[Backlog page](url)", or "Backlog page — url" — because
 * a url is pasted next to what it is.
 */
function notionTitle(before: string, url: string, id: string): string | null {
	// Notion's own slug wins whenever it is there: prose is a guess, and a
	// lead-in like "And the ADR:" reads as a label but names nothing.
	const slug = slugTitle(url, id);
	if (slug) return slug;
	const label =
		MARKDOWN_LABEL.exec(before)?.[1] ?? PROSE_LABEL.exec(before)?.[1];
	// Backticks and stray emphasis are markup, not part of the name.
	return label?.replace(/[`*_]/g, "").trim() || null;
}

/**
 * The one Notion page this session produced — pullRequests for the sessions
 * whose deliverable is a document rather than a diff. Those sessions were
 * leaving the brief with no link at all: a card that shipped code got a PR
 * pill, a card that shipped a page got nothing.
 *
 * One page, not a list. A session that reads a Notion database quotes a url
 * per row, and rows come back as bare /p/<id> with no slug — so the brief was
 * rendering a dozen identical "Notion page" lines, which is worse than none.
 * A titled page therefore beats an untitled newer one; otherwise newest wins.
 *
 * Keyed by page id, because the same page comes out as /p/<id> in one turn and
 * as a slug url in the next.
 */
export function notionPage(messages: BriefMessage[]): NotionPageLink | null {
	const found = new Map<string, NotionPageLink>();
	for (const message of messages.filter((m) => m.role === "assistant")) {
		for (const match of message.text.matchAll(NOTION_URL)) {
			const url = match[0].replace(/[).,]+$/, "");
			const id = NOTION_ID.exec(url)?.[0];
			// A workspace root or search url carries no page id — nothing to reopen.
			if (!id || found.has(id)) continue;
			const title = notionTitle(message.text.slice(0, match.index), url, id);
			found.set(id, { url, id, title });
		}
	}
	const pages = [...found.values()].reverse();
	return pages.find((page) => page.title) ?? pages[0] ?? null;
}

export interface JiraIssueLink {
	url: string;
	key: string;
}

const JIRA_URL =
	/https:\/\/([\w-]+\.atlassian\.net)\/browse\/([A-Z][A-Z0-9]+-\d+)/;

/**
 * The Jira issue this session is about: the first one linked anywhere in the
 * conversation, by you or the agent. A session launched from Slack has no
 * launch brief for sourceLink to read, so this is the only way its ticket
 * reaches the drawer. Rebuilt from the key so a pasted link's tracking query
 * (atlOrigin and the like) is dropped.
 */
export function jiraIssue(messages: BriefMessage[]): JiraIssueLink | null {
	for (const message of messages) {
		const match = JIRA_URL.exec(message.text);
		if (!match) continue;
		const [, host, key] = match;
		return { key, url: `https://${host}/browse/${key}` };
	}
	return null;
}

// Trailing ")" / "." is markdown and prose. The query string carries thread_ts,
// which is what makes the link open the thread rather than the channel.
const SLACK_URL =
	/https:\/\/[\w-]+\.slack\.com\/archives\/[\w-]+\/p\d+(?:\?[\w=&.%-]+)?/;

/**
 * The Slack thread this session came from. Slack-sourced sessions open with
 * "This task comes from a Slack thread: <url>" (see buildThreadPrompt), so the
 * first Slack link in the transcript is the thread you were reacting to —
 * later ones are whatever the agent quoted while working.
 */
export function slackThread(messages: BriefMessage[]): string | null {
	for (const message of messages) {
		const found = SLACK_URL.exec(message.text)?.[0];
		if (found) return found.replace(/[).,]+$/, "");
	}
	return null;
}

/**
 * When the conversation last moved, as epoch ms — the newest turn carrying a
 * timestamp. This is what a card's age badge should read: "in this status
 * since" is measured from the moment the board first saw the pane, so it
 * resets to "now" on every reload and reports minutes for a session that has
 * been sitting untouched for days.
 *
 * Walks back rather than taking the tail: older transcripts have turns with no
 * timestamp, and one of those at the end shouldn't blank the badge.
 */
export function lastMessageAt(messages: BriefMessage[]): number | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const at = messages[index]?.at;
		const ms = at ? Date.parse(at) : Number.NaN;
		if (!Number.isNaN(ms)) return ms;
	}
	return null;
}

/**
 * A card's age badge. Reads a real conversation timestamp, so unlike the old
 * "since the board noticed this pane" clock it routinely lands days out — a
 * session parked on Friday is the exact one you want to spot on Monday, and
 * "70h 30m" is not something anyone reads at a glance.
 */
export function elapsedLabel(
	since: number | undefined,
	now = Date.now(),
): string | null {
	if (!since) return null;
	const minutes = Math.round((now - since) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * When a 5-field cron expression (local time, the way CronCreate books it)
 * next fires after `from`, or null if it doesn't within the 7 days a
 * recurring job lives. Handles `*`, `a`, `a-b`, `a,b` and `/n` steps.
 *
 * ponytail: minute-by-minute scan, ~10k steps worst case. Fine for a pill.
 */
export function nextCronFire(expr: string, from = Date.now()): number | null {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const bounds: [number, number][] = [
		[0, 59],
		[0, 23],
		[1, 31],
		[1, 12],
		[0, 7],
	];
	const sets = fields.map((field, i) => {
		const [lo, hi] = bounds[i] as [number, number];
		const hits = new Set<number>();
		for (const part of field.split(",")) {
			const [range = "", step = "1"] = part.split("/");
			const [a, b] =
				range === "*"
					? [lo, hi]
					: range.includes("-")
						? range.split("-").map(Number)
						: [Number(range), step === "1" ? Number(range) : hi];
			for (let v = a as number; v <= (b as number); v += Number(step) || 1)
				hits.add(v);
		}
		// Sunday is both 0 and 7.
		if (i === 4 && hits.has(7)) hits.add(0);
		return hits;
	});
	const [min, hour, dom, month, dow] = sets as Set<number>[];
	// Cron's quirk: a restricted day-of-month and day-of-week match either.
	const domAny = fields[2] === "*";
	const dowAny = fields[4] === "*";
	const t = new Date(from);
	t.setSeconds(0, 0);
	for (let i = 0; i < 7 * 24 * 60; i++) {
		t.setMinutes(t.getMinutes() + 1);
		const dayHit =
			domAny || dowAny
				? (domAny || dom?.has(t.getDate())) && (dowAny || dow?.has(t.getDay()))
				: dom?.has(t.getDate()) || dow?.has(t.getDay());
		if (
			dayHit &&
			month?.has(t.getMonth() + 1) &&
			hour?.has(t.getHours()) &&
			min?.has(t.getMinutes())
		)
			return t.getTime();
	}
	return null;
}

/**
 * The row a session was launched from. Jira and PR rows persist `title\nurl`
 * as the pane's launch brief, so the first link in it is the ticket (or pull
 * request) the session exists to work on — and it was being stored and never
 * shown, which left a card titled "CRR-862: …" with no way to open CRR-862.
 *
 * Host parsed by hand rather than `new URL`: a throw here is a blank drawer.
 */
export function sourceLink(
	brief: string | null | undefined,
): { url: string; label: string } | null {
	// Trailing ")" / "." is prose, same as the PR and Slack patterns above.
	const url = brief?.match(/https?:\/\/\S+/)?.[0].replace(/[).,]+$/, "");
	if (!url) return null;
	// An issue key is what people call the thing; anything else gets its host.
	const key = url.match(/\/browse\/([A-Z][A-Z0-9]*-\d+)/)?.[1];
	return {
		url,
		label: key ?? url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0],
	};
}

/**
 * What a link you attached to the brief yourself is called: an issue key, a
 * PR number, a Notion title, "Slack thread" — else its host, so a raw url
 * never has to be read to know where it goes.
 */
export function linkLabel(url: string): string {
	const pr = url.match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/);
	if (pr) return `${pr[1]} #${pr[2]}`;
	if (/\.slack\.com\/archives\/[\w-]+\/p\d+/.test(url)) return "Slack thread";
	if (/\.slack\.com\/archives\//.test(url)) return "Slack channel";
	const notionId = /notion\.(?:so|com|site)\//.test(url)
		? NOTION_ID.exec(url)?.[0]
		: undefined;
	if (notionId) return notionTitle(url, notionId) ?? "Notion page";
	return sourceLink(url)?.label ?? url;
}

/**
 * What you typed into "My links": every url in it, and — when there's one —
 * whatever else you wrote as its name. "https://…/p123 deploy rollback" is a
 * link called "deploy rollback".
 */
export function parseLinks(input: string): { url: string; name?: string }[] {
	const urls = (input.match(/https?:\/\/\S+/g) ?? []).map((url) =>
		url.replace(/[).,]+$/, ""),
	);
	const name = input
		.replace(/https?:\/\/\S+/g, "")
		.replace(/\s+/g, " ")
		.replace(/^[\s:–—-]+|[\s:–—-]+$/g, "");
	if (urls.length === 1 && name) return [{ url: urls[0], name }];
	return urls.map((url) => ({ url }));
}

export type LinkKind = "jira" | "slack" | "pr" | "notion" | "other";

/** Which brief section a link you added belongs in. */
export function linkKind(url: string): LinkKind {
	if (/\.atlassian\.net\/browse\//.test(url)) return "jira";
	if (/\.slack\.com\/archives\//.test(url)) return "slack";
	if (/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(url)) return "pr";
	if (/notion\.(?:so|com|site)\//.test(url)) return "notion";
	return "other";
}
