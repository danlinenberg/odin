/**
 * Slack user mentions as the person's name for the phone: a draft's
 * `<@U0123ABCD>` reads "@Riley", as the desktop's draft card shows it, and a
 * title already flattened to "@U0123ABCD" reads "@Riley" too.
 */

/** `<@U123>`, `<@U123|label>`, or a bare `@U123` left by an earlier flatten. */
const MENTION = /<@([UW][A-Z0-9]{6,})(?:\|[^>]*)?>|@([UW][A-Z0-9]{8,})\b/g;

/** Every user id the text mentions, once each. */
export function mentionIds(text: string): string[] {
	return [...new Set(Array.from(text.matchAll(MENTION), (m) => m[1] ?? m[2]))];
}

/** The text with each mention a name it has; one it lacks reads "@id". */
export function withNames(text: string, names: Map<string, string>): string {
	return text.replace(
		MENTION,
		(_whole, raw: string | undefined, bare: string | undefined) => {
			const id = raw ?? bare ?? "";
			return `@${names.get(id) ?? id}`;
		},
	);
}

/**
 * How long a reply waits on Slack for names. The phone polls a session every
 * few seconds, so it never sits behind Slack: a lookup still out lands in the
 * cache, and the next poll has the name.
 */
const SLACK_WAIT_MS = 300;

/** Names for these ids, whatever came back within `waitMs`. */
async function namesFor(
	ids: string[],
	lookup: (id: string) => Promise<string | null>,
	waitMs: number,
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (ids.length === 0) return names;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.all(
			ids.map(async (id) => {
				const name = await lookup(id).catch(() => null);
				if (name) names.set(id, name);
			}),
		),
		new Promise<void>((done) => {
			timer = setTimeout(done, waitMs);
		}),
	]).finally(() => clearTimeout(timer));
	return names;
}

/** One text with its mentions named. */
export async function namedText(
	text: string,
	lookup: (id: string) => Promise<string | null>,
	waitMs = SLACK_WAIT_MS,
): Promise<string> {
	const ids = mentionIds(text);
	if (ids.length === 0) return text;
	return withNames(text, await namesFor(ids, lookup, waitMs));
}

/** Messages with the mentions in their text named, in one round of lookups. */
export async function namedMessages<T extends { text: string }>(
	messages: T[],
	lookup: (id: string) => Promise<string | null>,
	waitMs = SLACK_WAIT_MS,
): Promise<T[]> {
	const ids = [...new Set(messages.flatMap((m) => mentionIds(m.text)))];
	if (ids.length === 0) return messages;
	const names = await namesFor(ids, lookup, waitMs);
	return messages.map((m) =>
		mentionIds(m.text).length ? { ...m, text: withNames(m.text, names) } : m,
	);
}
