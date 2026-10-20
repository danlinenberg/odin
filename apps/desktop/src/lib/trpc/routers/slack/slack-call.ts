import { TRPCError } from "@trpc/server";

const SLACK_API = "https://slack.com/api";

export interface SlackResponse {
	ok?: boolean;
	error?: string;
}

export type SlackFetch = (
	url: string,
	init: { headers: Record<string, string> },
) => Promise<Response>;

export interface SlackCallOptions {
	/**
	 * Wait out a rate limit and ask again (the default), or take it as the
	 * answer. Off for a read whose caller comes back on its own anyway - the
	 * once-a-minute reply watch - on a method Slack allows once a minute:
	 * every retry there would only spend the next minute's one call.
	 */
	retry?: boolean;
}

/**
 * One Slack Web API client: at most `slots` requests on the wire at once,
 * and a rate limit waited out off the wire.
 *
 * A call sleeping through a 60-second Retry-After used to keep its slot. Four
 * of them - the reply watch asking conversations.history about four DMs,
 * each refused because Slack allows that method once a minute - shut every
 * other Slack read out, the queue sync among them, and the Slack feed sat
 * blank with nothing to say for itself.
 */
export function createSlackClient({
	fetch,
	sleep,
	slots = 4,
}: {
	fetch: SlackFetch;
	sleep: (ms: number) => Promise<void>;
	slots?: number;
}) {
	let inFlight = 0;
	const waiting: (() => void)[] = [];

	// A slot is held for one request on the wire, never for a wait.
	async function send(url: string, token: string): Promise<Response> {
		if (inFlight >= slots)
			await new Promise<void>((resolve) => waiting.push(resolve));
		else inFlight++;
		try {
			return await fetch(url, {
				headers: { Authorization: `Bearer ${token}` },
			});
		} finally {
			const next = waiting.shift();
			if (next) next();
			else inFlight--;
		}
	}

	return {
		async call<T extends SlackResponse>(
			method: string,
			params: Record<string, string>,
			token: string,
			{ retry = true }: SlackCallOptions = {},
		): Promise<T> {
			const url = `${SLACK_API}/${method}?${new URLSearchParams(params)}`;
			// A rate limit is "not yet", not an answer: wait what Slack says and
			// ask again. Giving up here is what made each sweep read a different
			// random slice of the backlog as UNKNOWN.
			let res = await send(url, token);
			for (
				let attempt = 0;
				retry && res.status === 429 && attempt < 5;
				attempt++
			) {
				const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
				await sleep(wait * 1000);
				res = await send(url, token);
			}
			const json = (await res.json()) as T;
			if (!json.ok) {
				throw new TRPCError({
					code: json.error === "invalid_auth" ? "UNAUTHORIZED" : "BAD_REQUEST",
					message: `Slack ${method}: ${json.error ?? `HTTP ${res.status}`}`,
				});
			}
			return json;
		},
	};
}
