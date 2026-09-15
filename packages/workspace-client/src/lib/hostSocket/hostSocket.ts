import { WebSocket as ReconnectingWebSocket } from "partysocket";

export interface HostSocketOptions {
	/** URL for this attempt, WITHOUT the auth token — the wrapper signs it. */
	buildUrl: () => string | Promise<string>;
	/** Fresh token per attempt. */
	getToken: () => string | null | Promise<string | null>;
	minReconnectionDelay?: number;
	maxReconnectionDelay?: number;
	maxRetries?: number;
	connectionTimeout?: number;
	/** Defaults to 0: send() is a no-op unless the socket is open. Opt into
	 * partysocket's buffer-and-replay only when stale sends are safe. */
	maxEnqueuedMessages?: number;
}

export type HostSocket = ReconnectingWebSocket;

// Accepts http(s) host URLs and converts to ws(s), so consumers can pass
// their host URL straight through without scheme juggling.
function signUrl(url: string, token: string | null): string {
	const u = new URL(url);
	if (u.protocol === "http:") u.protocol = "ws:";
	if (u.protocol === "https:") u.protocol = "wss:";
	if (token) u.searchParams.set("token", token);
	return u.toString();
}

/**
 * Reconnecting WebSocket for the host service. partysocket evaluates the async
 * URL provider before EVERY attempt, so each dial carries a fresh token — the
 * class of bug where a reconnect loop reuses a URL signed with a rotated token
 * can't recur here.
 */
export function createHostSocket(opts: HostSocketOptions): HostSocket {
	const provider = async (): Promise<string> =>
		signUrl(await opts.buildUrl(), await opts.getToken());

	return new ReconnectingWebSocket(provider, [], {
		minReconnectionDelay: opts.minReconnectionDelay,
		maxReconnectionDelay: opts.maxReconnectionDelay,
		maxRetries: opts.maxRetries,
		connectionTimeout: opts.connectionTimeout,
		maxEnqueuedMessages: opts.maxEnqueuedMessages ?? 0,
	});
}
