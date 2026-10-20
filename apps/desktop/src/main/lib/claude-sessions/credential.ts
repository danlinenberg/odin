/**
 * Which credential a conversation runs on, read off the `api-request` rows
 * Claude Code logs per API call. A request through the claude.ai login - the
 * Claude plan, or a `claude setup-token` token - carries the `oauth-2025-04-20`
 * beta; a request on an API key (or Bedrock, Vertex) does not. The last row
 * is the credential right now: a session can move from the plan to the key
 * when the plan runs out, by claude-auto on the laptop or the run script on
 * a remote host.
 */

export type Credential = "plan" | "key";

export interface SessionCredential {
	/** What the latest request authenticated with. */
	now: Credential;
	/** When the session moved onto `now`, ISO; null when it started there. */
	since: string | null;
}

const OAUTH_BETA = "oauth-2025-04-20";

export function transcriptCredential(jsonl: string): SessionCredential | null {
	let now: Credential | null = null;
	let since: string | null = null;
	for (const line of jsonl.split("\n")) {
		if (!line.includes('"api-request"')) continue;
		try {
			const { type, params, timestamp } = JSON.parse(line) as {
				type?: string;
				params?: { betas?: unknown };
				timestamp?: string;
			};
			if (type !== "api-request" || !Array.isArray(params?.betas)) continue;
			const credential: Credential = params.betas.includes(OAUTH_BETA)
				? "plan"
				: "key";
			if (credential !== now) since = now ? (timestamp ?? null) : null;
			now = credential;
		} catch {}
	}
	return now ? { now, since } : null;
}
