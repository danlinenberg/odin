import { slackTextToPlain } from "lib/trpc/routers/slack/reactions";
import { emojify } from "renderer/lib/emoji";

/**
 * A title the way the desktop card reads it: Slack's bold, italic and strike
 * markers gone (`_*SECURITY ALERT*_` is SECURITY ALERT) and `:pray:` an emoji.
 * An underscore inside a word (snake_case) stays.
 */
export function tidyTitle(text: string): string {
	return emojify(
		text
			.replace(/[*~]/g, "")
			.replace(/(^|\s)_+(?=\S)/g, "$1")
			.replace(/(\S)_+(?=\s|$|[.,:;!?])/g, "$1")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

/**
 * Longest a title waits on Slack for names. The board answers a poll every
 * few seconds, so it never sits behind Slack: a lookup still out lands in the
 * cache, and the next poll has the name.
 */
const SLACK_WAIT_MS = 300;

/**
 * A session title for the phone: Slack's raw markup (`<@U08EJ28KM0V>`,
 * `<!here>`, `:rotating_light:`) as names, @here and emoji. Names Slack
 * doesn't give in time read as @id, as with Slack not connected.
 */
export async function readableTitle(
	raw: string,
	names: (raw: string) => Promise<string> = async (text) =>
		(await import("lib/trpc/routers/slack")).slackReadable(text),
	waitMs = SLACK_WAIT_MS,
): Promise<string> {
	if (!raw) return raw;
	const plain = slackTextToPlain(raw);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const text = await Promise.race([
		names(raw).catch(() => plain),
		new Promise<string>((done) => {
			timer = setTimeout(() => done(plain), waitMs);
		}),
	]).finally(() => clearTimeout(timer));
	return tidyTitle(text);
}

/** Rows with their titles made readable, as `readableTitle` does one. */
export function readableTitles<T extends { title: string }>(
	rows: T[],
): Promise<T[]> {
	return Promise.all(
		rows.map(async (row) => ({
			...row,
			title: await readableTitle(row.title),
		})),
	);
}
