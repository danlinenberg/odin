/** What Odin types into a session whose turn failed on a passing API error. */
export const TRANSIENT_RETRY =
	"That turn failed on a passing API error. Retry it: carry on with my last message.";

/** Retries in a row before the session is left for you in Needs you. */
export const TRANSIENT_RETRY_MAX = 3;

/**
 * API errors that pass on their own: a Cloudflare challenge page (Claude Code
 * prints "Please run /login" before it, but signing in doesn't help), a server
 * error, overloaded, a dropped connection or a timeout. A plain 401/403 is a
 * real sign-in problem and is left alone.
 */
const TRANSIENT_RE =
	/API Error: (?:5\d\d\b|403 Attention Required|.*\bCloudflare\b|.*\boverloaded)|API Error: Connection error|Request timed out|API Error: .*\bECONNRESET\b/i;

export function isTransientApiError(text: string): boolean {
	return TRANSIENT_RE.test(text);
}

/**
 * Whether a session whose turn just failed should be sent TRANSIENT_RETRY:
 * its last reply is a passing API error and fewer than TRANSIENT_RETRY_MAX
 * retries were sent since your last real message. Returns the key that marks
 * this retry done (one per failed reply), or null.
 */
export function transientRetryKey(
	paneId: string,
	messages: { role: string; text: string }[],
): string | null {
	const last = messages.at(-1);
	if (last?.role !== "assistant" || !isTransientApiError(last.text))
		return null;
	let retries = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "user") continue;
		if (m.text.trim() !== TRANSIENT_RETRY) break;
		retries++;
	}
	if (retries >= TRANSIENT_RETRY_MAX) return null;
	return `${paneId}:${messages.length}`;
}
