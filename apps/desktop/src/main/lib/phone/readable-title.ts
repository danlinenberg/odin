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
 * A session title for the phone: Slack's raw markup (`<@U08EJ28KM0V>`,
 * `<!here>`, `:rotating_light:`) as names, @here and emoji.
 */
export async function readableTitle(raw: string): Promise<string> {
	if (!raw) return raw;
	const { slackReadable } = await import("lib/trpc/routers/slack");
	return tidyTitle(await slackReadable(raw));
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
