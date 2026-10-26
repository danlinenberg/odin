/**
 * A Sentry issue link - `https://imagenai.sentry.io/issues/7812764568/?...`.
 * Sentry posts one alert to a channel and DMs the same one, each with its own
 * query string, so the issue id is the only part the two share.
 */
const SENTRY_ISSUE =
	/\bsentry\.io\/(?:organizations\/[^/\s]+\/)?issues\/(\d+)/g;

/** Every Sentry issue the texts link to, as `sentry:<issue id>`. */
export function sentryRefs(...texts: (string | null | undefined)[]): string[] {
	return texts.flatMap((text) =>
		Array.from(text?.matchAll(SENTRY_ISSUE) ?? [], (m) => `sentry:${m[1]}`),
	);
}
