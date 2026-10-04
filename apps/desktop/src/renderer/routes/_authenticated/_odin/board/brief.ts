/**
 * "What is this session about, and where is it at?" - derived from Claude's own
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
	/** What the agent last said with something in it - the de-facto status. */
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
 * older transcripts the newest turn is that - which says nothing about what
 * you asked for. Your real last instruction is the one before it.
 */
const RESUME_STUB = /^\s*continue\.?\s*$/i;

export function sessionBrief(messages: BriefMessage[]): SessionBrief {
	const users = messages.filter(
		(message) => message.role === "user" && !RESUME_STUB.test(message.text),
	);
	const assistants = messages.filter((message) => message.role === "assistant");
	// "Ok." / "Done." is the reply, but the report is the turn before it - walk
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
 * the conversation - a session that opened a PR always ends up printing its URL,
 * and that link is the first thing you want when you come back to it.
 *
 * Most recent first because a long-running session can open a dozen (one deploy
 * session had 15), and the one you want is the one it just made.
 *
 * Claude's turns only. A PR you paste in yourself is the session's *input* -
 * "run it on this pr" - not its output, and listing it as one of the session's
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

/** "…/Spot-Instances-…-<id>" - Notion puts the page title in the path. */
function notionTitle(url: string, id: string): string | null {
	const slug = url
		.split("?")[0]
		?.split("/")
		.pop()
		?.replace(new RegExp(`-?${id}$`), "");
	return slug
		? decodeURIComponent(slug).replace(/-+/g, " ").trim() || null
		: null;
}

/**
 * The one Notion page this session produced - pullRequests for the sessions
 * whose deliverable is a document rather than a diff. Those sessions were
 * leaving the brief with no link at all: a card that shipped code got a PR
 * pill, a card that shipped a page got nothing.
 *
 * One page, not a list. A session that reads a Notion database quotes a url
 * per row, and rows come back as bare /p/<id> with no slug - so the brief was
 * rendering a dozen identical "Notion page" lines, which is worse than none.
 *
 * The newest turn that links a page decides, and within it the first page it
 * links: a closing report leads with what it made, and the pages it names
 * after that are references. Ranking pages by their first mention anywhere let
 * a reference in the report outrank a deliverable linked once before it.
 *
 * Keyed by page id, because the same page comes out as /p/<id> in one turn and
 * as a slug url in the next; the slug url wins, since it carries the title.
 */
export function notionPage(messages: BriefMessage[]): NotionPageLink | null {
	const found = new Map<string, NotionPageLink>();
	let lead: string | undefined;
	for (const message of messages.filter((m) => m.role === "assistant")) {
		let first: string | undefined;
		for (const match of message.text.match(NOTION_URL) ?? []) {
			const url = match.replace(/[).,]+$/, "");
			const id = NOTION_ID.exec(url)?.[0];
			// A workspace root or search url carries no page id - nothing to reopen.
			if (!id) continue;
			first ??= id;
			if (!found.get(id)?.title)
				found.set(id, { url, id, title: notionTitle(url, id) });
		}
		lead = first ?? lead;
	}
	return (lead && found.get(lead)) || null;
}

// claude.ai/artifact/<id> and claude.ai/code/artifact/<uuid>.
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g;

/**
 * The artifact this session published - its deliverable when that's a page
 * rather than a diff or a doc. Newest wins: a session republishes the same url
 * as it iterates, and a second artifact supersedes the first far more often
 * than it sits beside it. Claude's turns only, like pullRequests: one you
 * pasted in is input.
 */
export function artifactLink(messages: BriefMessage[]): string | null {
	let found: string | null = null;
	for (const message of messages.filter((m) => m.role === "assistant"))
		for (const url of message.text.match(ARTIFACT_URL) ?? []) found = url;
	return found;
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

/** A run of prose, and the link it names when it's a PR or ticket. */
export interface RefPart {
	text: string;
	url?: string;
}

// "imagen-public-mcp #2", "terraform#1455", "PR #6670", "#12" - or a Jira key.
const REF = /\b([A-Z][A-Z0-9]+-\d+)\b|(?:\b([A-Za-z][\w.-]*)( ?))?#(\d+)\b/g;

/**
 * Split prose at the PRs and tickets it mentions, linking only ones this
 * session quoted - a bare "#2" means nothing on its own, the session's own
 * links say which #2. A repo name or "PR" in front joins the link.
 */
export function linkRefs(
	text: string,
	prs: PullRequestLink[],
	issue: JiraIssueLink | null,
): RefPart[] {
	const parts: RefPart[] = [];
	let last = 0;
	for (const match of text.matchAll(REF)) {
		const [whole, key, word, space, number] = match;
		const at = match.index ?? 0;
		let start = at;
		let url: string | undefined;
		if (key) url = issue?.key === key ? issue.url : undefined;
		else {
			const same = prs.filter((pr) => pr.number === Number(number));
			const repo =
				word &&
				same.find(
					(pr) =>
						pr.repo.split("/").pop()?.toLowerCase() === word.toLowerCase(),
				);
			if (repo || word?.toUpperCase() === "PR") url = (repo || same[0])?.url;
			// "Merge #12": the number is the link. "other-repo#12" names a PR this
			// session never quoted - leave it.
			else if (!word || (space && same.length === 1)) {
				url = same.length === 1 ? same[0].url : undefined;
				start = at + whole.indexOf("#");
			}
		}
		if (!url) continue;
		if (start > last) parts.push({ text: text.slice(last, start) });
		parts.push({ text: text.slice(start, at + whole.length), url });
		last = at + whole.length;
	}
	if (last < text.length) parts.push({ text: text.slice(last) });
	return parts;
}

// Trailing ")" / "." is markdown and prose. The query string carries thread_ts,
// which is what makes the link open the thread rather than the channel.
const SLACK_URL =
	/https:\/\/[\w-]+\.slack\.com\/archives\/[\w-]+\/p\d+(?:\?[\w=&.%-]+)?/;

/**
 * The Slack thread this session came from. Slack-sourced sessions open with
 * "This task comes from a Slack thread: <url>" (see buildThreadPrompt), so the
 * first Slack link in the transcript is the thread you were reacting to -
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
 * When the conversation last moved, as epoch ms - the newest turn carrying a
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
 * "since the board noticed this pane" clock it routinely lands days out - a
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
 * request) the session exists to work on - and it was being stored and never
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
 * PR number, a Notion title, "Slack thread" - else its host, so a raw url
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
	if (/claude\.ai\/(?:code\/)?artifact\//.test(url)) return "Artifact";
	return sourceLink(url)?.label ?? url;
}

/**
 * What you typed into "My links": every url in it, and - when there's one -
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
		.replace(/^[\s:–\u2014-]+|[\s:–\u2014-]+$/g, "");
	if (urls.length === 1 && name) return [{ url: urls[0], name }];
	return urls.map((url) => ({ url }));
}

export type LinkKind =
	| "jira"
	| "slack"
	| "pr"
	| "notion"
	| "artifact"
	| "other";

/** Which brief section a link you added belongs in. */
export function linkKind(url: string): LinkKind {
	if (/\.atlassian\.net\/browse\//.test(url)) return "jira";
	if (/\.slack\.com\/archives\//.test(url)) return "slack";
	if (/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(url)) return "pr";
	if (/notion\.(?:so|com|site)\//.test(url)) return "notion";
	if (/claude\.ai\/(?:code\/)?artifact\//.test(url)) return "artifact";
	return "other";
}

/**
 * The open ACTION ITEMS of the agent's newest turn - what you owe the session.
 * Only the last turn counts: an older turn's list was already answered or
 * superseded. "ACTION ITEMS: none" and a turn without the section give [].
 */
export function actionItems(messages: BriefMessage[]): string[] {
	const last = messages.findLast((m) => m.role === "assistant")?.text ?? "";
	const at = last.toUpperCase().lastIndexOf("ACTION ITEMS");
	if (at < 0) return [];
	return last
		.slice(at + "ACTION ITEMS".length)
		.split("\n")
		.map((line) => line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)/)?.[1]?.trim())
		.filter((item): item is string => !!item);
}

// "Merge PR #12", "Review and merge #12", "Get repo#12 merged" - a merge is the
// whole item.
const MERGE_ITEM =
	/^(?:(?:review|approve)(?:,| and)\s+)?merge\b|^get\b.*\bmerged\b/i;

/**
 * The session is finished bar the click: every open action item is a merge.
 * A card in that state needs thirty seconds of you, not a read-through.
 */
export function onlyMergeLeft(messages: BriefMessage[]): boolean {
	const items = actionItems(messages);
	return items.length > 0 && items.every((item) => MERGE_ITEM.test(item));
}

// A look at work that already shipped. "Check why…", "Confirm I should…",
// restarts and "Open Settings and set X" stay open.
const LOOK_ITEMS = [
	// "Reload the Odin window (⌘R) and open the All feed", "Close the drawer".
	/^(?:press\s+)?(?:⌘R|cmd\+R)|^(?:hard[- ])?(?:reload|refresh)\b|^close\b.*\bdrawer\b/i,
	// "Check that the badge matches", "Confirm the row stays gone".
	/^(?:check|confirm) that\b|^confirm the\b/i,
	// "Open Insights and check the color", "Click Resume; confirm it opens".
	/^(?:open|reopen|go to|click|right-click|press|close|resume|type|search|switch|toggle|star|mark|add|pick|set|hover|resize|let|leave|start|glance at|look at)\b.*\b(?:check|confirm|see|try)\b/i,
];
// "Confirm the two channels should stay out" is a question.
const ASKS = /\bshould\b|\?\s*$/i;

/**
 * The session is finished: every open action item is a look at what shipped.
 * That card is Done, not Needs you - the items still show in its brief.
 */
export function onlyLookLeft(messages: BriefMessage[]): boolean {
	const items = actionItems(messages);
	return (
		items.length > 0 &&
		items.every(
			(item) => !ASKS.test(item) && LOOK_ITEMS.some((re) => re.test(item)),
		)
	);
}

/**
 * The PRs the merge items are about: the ones they name ("#12", "…/pull/12"),
 * else the newest PR the session linked. Newest first, like pullRequests.
 */
export function mergeTargets(messages: BriefMessage[]): PullRequestLink[] {
	const items = actionItems(messages).join(" ");
	const prs = pullRequests(messages);
	const named = prs.filter((pr) =>
		new RegExp(`(?:#|/pull/)${pr.number}\\b`).test(items),
	);
	return named.length ? named : prs.slice(0, 1);
}

/**
 * The PRs mergeReady judges a session on. ponytail: the 20 newest -
 * pullRequestStates' cap; a session that linked more is judged on those.
 */
export function mergeCheckUrls(messages: BriefMessage[]): string[] {
	return pullRequests(messages)
		.slice(0, 20)
		.map((pr) => pr.url);
}

/**
 * Finished, bar a click: every PR of yours the session linked (a teammate's
 * isn't yours to merge) is approved with no red
 * check, merged, or closed - and at least one is still open waiting on that
 * click. That card is Done, not Needs you, whatever else its action items say.
 * With all of them merged it takes a merge-only item list to say the same
 * thing; otherwise the items are what's left. Unknown state (gh can't see the
 * PR, not fetched yet) is not approved, and a reply after the items means you
 * already answered them.
 */
type PrStates = Record<
	string,
	{
		state: string;
		approved?: boolean;
		failed?: string[];
		mine?: boolean | null;
	} | null
>;

export function mergeReady(
	messages: BriefMessage[],
	states: PrStates,
): boolean {
	if (messages[messages.length - 1]?.role !== "assistant") return false;
	const prs = mergeCheckUrls(messages)
		.map((url) => states[url])
		.filter((pr) => pr?.mine !== false);
	if (
		!prs.length ||
		prs.some(
			(pr) =>
				!pr ||
				(pr.state === "OPEN" && (pr.approved !== true || !!pr.failed?.length)),
		)
	)
		return false;
	return (
		prs.some((pr) => pr?.state === "OPEN") ||
		(onlyMergeLeft(messages) && prs.some((pr) => pr?.state === "MERGED"))
	);
}

/**
 * Dropped: none of your PRs the session linked is still open, and at least one
 * was closed without merging. Whatever its action items say, that work was
 * abandoned, so the card is Done and says why.
 */
export function prsDropped(
	messages: BriefMessage[],
	states: PrStates,
): boolean {
	const prs = mergeCheckUrls(messages)
		.map((url) => states[url])
		.filter((pr) => pr?.mine !== false);
	return (
		prs.length > 0 &&
		prs.every((pr) => !!pr && pr.state !== "OPEN") &&
		prs.some((pr) => pr?.state === "CLOSED")
	);
}
