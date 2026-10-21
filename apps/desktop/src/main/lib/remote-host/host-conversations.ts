import type { Client } from "ssh2";
import { sh } from "./session";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

/**
 * Asks that overlap share one connection: a bulk Resume checks its rows a
 * beat apart, and a connection per row is what wedged the host's SSM before.
 * The connection closes once the last of them is answered.
 */
let shared: { key: string; client: Promise<Client>; users: number } | null =
	null;

export async function withSharedHost<T>(
	host: HostLogin,
	fn: (client: Client) => Promise<T>,
	connect: (host: HostLogin) => Promise<Client> = connectHost,
): Promise<T> {
	const key = `${host.instanceId}/${host.user}`;
	if (shared?.key !== key) shared = { key, client: connect(host), users: 0 };
	const lease = shared;
	lease.users++;
	try {
		return await fn(await lease.client);
	} finally {
		lease.users--;
		if (lease.users === 0) {
			if (shared === lease) shared = null;
			lease.client.then((client) => client.end()).catch(() => {});
		}
	}
}

/**
 * Whether the host has Claude's conversation for a session. The copy here of
 * a host session's transcript is a mirror, written while its pane is
 * connected: a session whose connect failed has none here and may still have
 * one there. Throws when the host can't be reached - that is not a no.
 */
export function hostHasConversation(
	host: HostLogin,
	sessionId: string,
	connect?: (host: HostLogin) => Promise<Client>,
): Promise<boolean> {
	return withSharedHost(
		host,
		async (client) =>
			(await runOnHost(
				client,
				`ls "$HOME"/.claude/projects/*/${sh(`${sessionId}.jsonl`)} 2>/dev/null | head -1; true`,
			)) !== "",
		connect,
	);
}
