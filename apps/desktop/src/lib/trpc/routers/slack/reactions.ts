/**
 * Pure helpers for the :eyes: feed - no network, no db, so they're testable
 * on their own (see reactions.test.ts).
 */

/** The reaction that puts a message in Odin's queue, until you change it. */
export const QUEUE_REACTION = "eyes";

/**
 * The reaction that queues a message AND starts its session - "take it
 * offline" from Slack itself, with nobody at the desk to press Start.
 */
export const LAUNCH_REACTION = "robot_face";

/**
 * `:eyes:`, `eyes`, ` Eyes ` → `eyes`. Slack names reactions, so a pasted
 * glyph (👀) is not accepted - ponytail: add a unicode→name table if typing
 * the name ever grates.
 */
export function normalizeReaction(name: string): string {
	return (
		name
			.trim()
			.replace(/^:+|:+$/g, "")
			.toLowerCase() || QUEUE_REACTION
	);
}

export interface SlackReactionsListItem {
	type?: string;
	channel?: string;
	message?: SlackListedMessage;
}

export interface SlackListedMessage {
	user?: string;
	username?: string;
	bot_id?: string;
	text?: string;
	attachments?: SlackAttachment[];
	ts?: string;
	thread_ts?: string;
	permalink?: string;
	reactions?: { name?: string; users?: string[] }[];
}

export interface SlackAttachment {
	pretext?: string;
	title?: string;
	text?: string;
	fallback?: string;
}

/**
 * A message's readable body. Bots (Datadog, Sentry) post an empty `text` and
 * put the alert in `attachments`, so fall back to those.
 */
export function messageBody(message: {
	text?: string;
	attachments?: SlackAttachment[];
}): string {
	if (message.text?.trim()) return message.text;
	return (message.attachments ?? [])
		.map(
			(a) =>
				[a.pretext, a.title, a.text].filter(Boolean).join("\n") ||
				(a.fallback ?? ""),
		)
		.filter(Boolean)
		.join("\n\n");
}

export interface EyedMessage {
	/** Slack's identity for a message, and our primary key. */
	id: string;
	channelId: string;
	messageTs: string;
	threadTs: string | null;
	authorId: string | null;
	text: string;
	permalink: string | null;
	/** It carries my launch reaction: start a session without asking. */
	launch: boolean;
}

export function reactionId(channelId: string, messageTs: string): string {
	return `${channelId}:${messageTs}`;
}

/**
 * The messages *I* put the queue reaction on. `reactions.list` returns every
 * reaction the user made, of any emoji, so both the emoji and the reactor are
 * checked - someone else's :eyes: is not my queue item.
 */
export function pickEyedMessages(
	items: SlackReactionsListItem[],
	myUserId: string,
	reaction: string = QUEUE_REACTION,
	launchReaction: string = LAUNCH_REACTION,
): EyedMessage[] {
	const eyed: EyedMessage[] = [];
	for (const item of items) {
		const message = item.message;
		if (item.type !== "message" || !item.channel || !message?.ts) continue;
		const mine = (name: string) =>
			message.reactions?.some(
				(r) => r.name === name && (r.users ?? []).includes(myUserId),
			) ?? false;
		const launch = mine(launchReaction);
		if (!launch && !mine(reaction)) continue;
		eyed.push(toEyedMessage(item.channel, message.ts, message, launch));
	}
	return eyed;
}

/** A Slack message as a queue row, whichever way it got into the queue. */
export function toEyedMessage(
	channelId: string,
	messageTs: string,
	message: SlackListedMessage,
	launch: boolean,
): EyedMessage {
	return {
		id: reactionId(channelId, messageTs),
		channelId,
		messageTs,
		threadTs: message.thread_ts ?? null,
		authorId: message.user ?? null,
		text: slackTextToPlain(messageBody(message)),
		permalink: message.permalink ?? null,
		launch,
	};
}

/**
 * One entry of `saved.list`, the undocumented web-client method behind
 * Slack's Later tab. It carries where the item is, not the message itself.
 */
export interface SlackSavedItem {
	/** The channel, for a message. */
	item_id?: unknown;
	item_type?: unknown;
	ts?: unknown;
	state?: unknown;
	todo_state?: unknown;
	is_archived?: unknown;
	date_completed?: unknown;
}

export interface SavedMessageRef {
	id: string;
	channelId: string;
	messageTs: string;
}

/**
 * The messages still open in my Later list. Saved files and channels are not
 * queue items, and neither is anything completed or archived. The response is
 * undocumented, so every field is checked rather than trusted.
 */
export function pickSavedMessages(items: unknown[]): SavedMessageRef[] {
	const picked = new Map<string, SavedMessageRef>();
	for (const raw of items) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as SlackSavedItem;
		const { item_id: channelId, ts: messageTs } = item;
		if (item.item_type !== "message") continue;
		if (typeof channelId !== "string" || !channelId) continue;
		if (typeof messageTs !== "string" || !messageTs) continue;
		const closed =
			item.state === "completed" ||
			item.todo_state === "completed" ||
			item.is_archived === true ||
			(typeof item.date_completed === "number" && item.date_completed > 0);
		if (closed) continue;
		const id = reactionId(channelId, messageTs);
		picked.set(id, { id, channelId, messageTs });
	}
	return [...picked.values()];
}

/**
 * Saved rows whose message has left my Later list - unsaved, completed or
 * archived. Unlike `reactions.list`, the caller reads the whole list, so a
 * missing row is an answer; only pass `savedIds` from a complete read.
 * A row I also :eyes:'d this sync stays open: the reaction still queues it.
 */
export function savedRowsToClose<
	T extends {
		id: string;
		source: string;
		unreactedAt: number | null;
		doneAt: number | null;
	},
>(rows: T[], savedIds: Set<string>, eyedIds: Set<string>): T[] {
	return rows.filter(
		(row) =>
			row.source === "saved" &&
			row.unreactedAt === null &&
			row.doneAt === null &&
			!savedIds.has(row.id) &&
			!eyedIds.has(row.id),
	);
}

/**
 * The message that carries a thread's facts, given the message a row points at.
 *
 * `reply_count`, `reply_users` and `latest_reply` live on the thread PARENT.
 * Read them off a reply - which is what a queue row often is, since you react
 * to the message that needs answering, not to whatever started the thread -
 * and a thread with 37 messages in it reads as "nobody has replied", aged off
 * the reply's own timestamp instead of the thread's last activity.
 *
 * Null when the message is already the parent (or stands alone): ask about
 * itself.
 */
export function threadParentTs(message: {
	ts?: string;
	thread_ts?: string;
}): string | null {
	const parent = message.thread_ts;
	if (!parent || parent === message.ts) return null;
	return parent;
}

/**
 * A DM's inline messages after a queued one, cut at the next message I queued
 * myself: that one is its own task, and in a DM to myself every later message
 * is. Reading past it handed one session the next task's request as context.
 */
export function untilNextQueued<
	T extends { ts?: string; reactions?: { name?: string; users?: string[] }[] },
>(messages: T[], queuedTs: string, myUserId: string, queue: Set<string>): T[] {
	const sorted = [...messages].sort((a, b) => Number(a.ts) - Number(b.ts));
	const next = sorted.findIndex(
		(m) =>
			Number(m.ts) > Number(queuedTs) &&
			(m.reactions ?? []).some(
				(r) =>
					queue.has(normalizeReaction(r.name ?? "")) &&
					(r.users ?? []).includes(myUserId),
			),
	);
	return next === -1 ? sorted : sorted.slice(0, next);
}

/**
 * Which stored rows to ask Slack about this sync.
 *
 * A row missing from a `reactions.list` page is not evidence of anything:
 * that list is ordered by when I reacted, not by when the message was posted,
 * so something I eyed weeks ago sits past the end of the page while its
 * message is newer than half of what is on it. The only honest answer for a
 * missing row is a `reactions.get` about that one message.
 *
 * ponytail: a few per sync, least-recently-confirmed first, and the caller
 * bumps `lastSeenAt` on every answer - so the queue rotates through in a
 * handful of polls instead of costing one call per row every two minutes.
 * Raise the budget if a queue ever grows faster than it rotates.
 */
export function rowsToVerify<
	T extends { id: string; lastSeenAt: number; doneAt: number | null },
>(rows: T[], stillEyed: Set<string>, budget: number): T[] {
	return rows
		.filter((row) => row.doneAt === null && !stillEyed.has(row.id))
		.sort((a, b) => a.lastSeenAt - b.lastSeenAt)
		.slice(0, budget);
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
};

/**
 * Slack's mrkdwn link/mention syntax rendered as something readable.
 * User and channel ids stay as ids when Slack didn't include a label -
 * resolving them would cost an API call per mention.
 */
export function slackTextToPlain(text: string): string {
	return text
		.replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, "@$1")
		.replace(/<([#@])([A-Z0-9]+)\|([^>]*)>/g, (_, sigil, _id, label) =>
			sigil === "#" ? `#${label}` : `@${label}`,
		)
		.replace(/<@([A-Z0-9]+)>/g, "@$1")
		.replace(/<#([A-Z0-9]+)>/g, "#$1")
		.replace(/<([^|>]+)\|([^>]*)>/g, (_, url, label) =>
			label === url ? url : `${label} (${url})`,
		)
		.replace(/<([^|>]+)>/g, "$1")
		.replace(/&amp;|&lt;|&gt;/g, (entity) => ENTITIES[entity] ?? entity)
		.trim();
}

/**
 * A Slack id as it survives `slackTextToPlain`: `@U08EJ28KM0V`. Real names
 * never look like this, so the shape alone is a safe enough match.
 */
const MENTION_ID = /@([UWB][A-Z0-9]{6,})\b/g;

/** The user ids still unresolved in a plain-text message. */
export function mentionedUserIds(text: string): string[] {
	return [...new Set(Array.from(text.matchAll(MENTION_ID), (m) => m[1]))];
}

/** `@U08EJ28KM0V` → `@Tamir Davidov`. Ids with no name stay as ids. */
export function replaceMentions(
	text: string,
	names: Map<string, string>,
): string {
	return text.replace(MENTION_ID, (whole, id: string) => {
		const name = names.get(id);
		return name ? `@${name}` : whole;
	});
}

/**
 * A line that is nothing but hello: "Hi Dan.", "Hi good morning :sunny:",
 * "@Dan Linenberg 🙏". Slack messages open with one routinely, and titling a
 * message by its first line then puts the greeting on the board card and
 * leaves the actual ask off it - and out of every search over titles.
 *
 * ponytail: a word list, not language detection. A greeting it doesn't know
 * costs one mistitled card, which is exactly what happens today anyway.
 */
export function isGreeting(line: string): boolean {
	return (
		line
			.replace(/:[a-z0-9_+-]+:/gi, "") // :sunny:
			.replace(/@[\w.'-]+(?: [\w.'-]+)?/g, "") // @Dan Linenberg
			// The greeting and whoever it greets: "hi Dan", "good morning all".
			.replace(
				/\b(?:hi+|hey+|hello+|good (?:morning|afternoon|evening)|morning|boker tov|shalom|yo|sup)\b[\s,]*[\w'-]*/gi,
				"",
			)
			// Anything left that isn't a letter or a digit (punctuation, 👀) was
			// never the message either.
			.replace(/[^\p{L}\p{N}]+/gu, "") === ""
	);
}

/** A one-line label for a message - first line that says something, capped. */
export function toTitle(text: string): string {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	// All greeting and no message: there's nothing better to call it than hello.
	const line = lines.find((l) => !isGreeting(l)) ?? lines[0];
	if (!line) return "(no text)";
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * Permalink for a message, when Slack didn't hand one over. Thread replies need
 * the parent ts, else the link opens the channel at the wrong place.
 */
export function buildPermalink(params: {
	teamUrl: string;
	channelId: string;
	messageTs: string;
	threadTs: string | null;
}): string {
	const { teamUrl, channelId, messageTs, threadTs } = params;
	const base = `${teamUrl.replace(/\/+$/, "")}/archives/${channelId}/p${messageTs.replace(".", "")}`;
	return threadTs && threadTs !== messageTs
		? `${base}?thread_ts=${threadTs}&cid=${channelId}`
		: base;
}

/** The three states a queued reaction can be in, in display order. */
export const REACTION_STATUSES = [
	"Not started",
	"In progress",
	"Done",
] as const;
export type ReactionStatus = (typeof REACTION_STATUSES)[number];

/**
 * A row's status, derived rather than stored: Done wins, then anything a
 * session was ever launched for is in progress. Deriving keeps one source of
 * truth - there's no status field to drift from the timestamps behind it.
 */
export function reactionStatus(row: {
	startedAt: number | null;
	doneAt: number | null;
}): ReactionStatus {
	if (row.doneAt !== null) return "Done";
	if (row.startedAt !== null) return "In progress";
	return "Not started";
}

/**
 * The stored channel name as something worth reading. Group DMs come back from
 * Slack under their internal name - `mpdm-dan.l--netanel--shahar-1` - which is
 * not a channel and should not wear a `#`.
 *
 * ponytail: the member list keeps you in it, because the label is built where
 * the identity isn't known. Drop self here if it ever reads as noise.
 */
export function channelLabel(name: string | null): string | null {
	if (!name) return null;
	const mpdm = /^mpdm-(.+?)-\d+$/.exec(name);
	if (mpdm) return mpdm[1].split("--").join(", ");
	return `#${name}`;
}
