/**
 * Pure helpers for the :eyes: feed — no network, no db, so they're testable
 * on their own (see reactions.test.ts).
 */

/** The reaction that puts a message in Odin's queue, until you change it. */
export const QUEUE_REACTION = "eyes";

/**
 * `:eyes:`, `eyes`, ` Eyes ` → `eyes`. Slack names reactions, so a pasted
 * glyph (👀) is not accepted — ponytail: add a unicode→name table if typing
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
	message?: {
		user?: string;
		username?: string;
		bot_id?: string;
		text?: string;
		ts?: string;
		thread_ts?: string;
		permalink?: string;
		reactions?: { name?: string; users?: string[] }[];
	};
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
}

export function reactionId(channelId: string, messageTs: string): string {
	return `${channelId}:${messageTs}`;
}

/**
 * The messages *I* put the queue reaction on. `reactions.list` returns every
 * reaction the user made, of any emoji, so both the emoji and the reactor are
 * checked — someone else's :eyes: is not my queue item.
 */
export function pickEyedMessages(
	items: SlackReactionsListItem[],
	myUserId: string,
	reaction: string = QUEUE_REACTION,
): EyedMessage[] {
	const eyed: EyedMessage[] = [];
	for (const item of items) {
		const message = item.message;
		if (item.type !== "message" || !item.channel || !message?.ts) continue;
		const mine = message.reactions?.some(
			(r) => r.name === reaction && (r.users ?? []).includes(myUserId),
		);
		if (!mine) continue;
		eyed.push({
			id: reactionId(item.channel, message.ts),
			channelId: item.channel,
			messageTs: message.ts,
			threadTs: message.thread_ts ?? null,
			authorId: message.user ?? null,
			text: slackTextToPlain(message.text ?? ""),
			permalink: message.permalink ?? null,
		});
	}
	return eyed;
}

/**
 * The oldest message timestamp in a `reactions.list` page — the far edge of
 * what this sync actually looked at. Rows older than this weren't examined, so
 * their reaction can't be assumed gone. Null when the page held no messages.
 */
export function oldestExaminedTs(
	items: SlackReactionsListItem[],
): string | null {
	let oldest: string | null = null;
	for (const item of items) {
		const ts = item.message?.ts;
		if (!ts) continue;
		// Slack ts is "seconds.micros" — lexical compare is wrong across digit
		// counts (a 9-digit ts sorts above a 10-digit one), so compare numerically.
		if (oldest === null || Number(ts) < Number(oldest)) oldest = ts;
	}
	return oldest;
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
};

/**
 * Slack's mrkdwn link/mention syntax rendered as something readable.
 * User and channel ids stay as ids when Slack didn't include a label —
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
		.replace(/<([^|>]+)\|([^>]*)>/g, "$2")
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
 * leaves the actual ask off it — and out of every search over titles.
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

/** A one-line label for a message — first line that says something, capped. */
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
 * truth — there's no status field to drift from the timestamps behind it.
 */
export function reactionStatus(row: {
	startedAt: number | null;
	doneAt: number | null;
}): ReactionStatus {
	if (row.doneAt !== null) return "Done";
	if (row.startedAt !== null) return "In progress";
	return "Not started";
}
