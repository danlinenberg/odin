import type { AppRouter } from "@odin/host-service";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";
import { getRemoteConnectionManager } from "./remote-connection-manager";

export type RemoteHostClient = ReturnType<typeof createTRPCClient<AppRouter>>;

/** The connected server's host-service, through the SSH tunnel's loopback port. */
export interface RemoteHostEndpoint {
	client: RemoteHostClient;
	baseUrl: string;
	wsBaseUrl: string;
	secret: string;
}

let cached: { key: string; endpoint: RemoteHostEndpoint } | null = null;

/**
 * The live endpoint, or null while no tunnel is up (not connected, or
 * reconnecting). Each reconnect opens a new local port, so the client is
 * rebuilt whenever the port or secret changes.
 */
export function getRemoteHostEndpoint(): RemoteHostEndpoint | null {
	const active = getRemoteConnectionManager().getActive();
	if (!active || active.status !== "connected") return null;
	const key = `${active.localPort}:${active.secret}`;
	if (cached?.key === key) return cached.endpoint;
	const baseUrl = `http://127.0.0.1:${active.localPort}`;
	const client = createTRPCClient<AppRouter>({
		links: [
			httpLink({
				url: `${baseUrl}/trpc`,
				transformer: superjson,
				headers: () => ({ Authorization: `Bearer ${active.secret}` }),
			}),
		],
	});
	cached = {
		key,
		endpoint: {
			client,
			baseUrl,
			wsBaseUrl: `ws://127.0.0.1:${active.localPort}`,
			secret: active.secret,
		},
	};
	return cached.endpoint;
}

/** Like {@link getRemoteHostEndpoint}, but throws a user-facing error offline. */
export function requireRemoteHostEndpoint(): RemoteHostEndpoint {
	const endpoint = getRemoteHostEndpoint();
	if (!endpoint) {
		throw new Error(
			"The remote server is not connected right now. Odin keeps reconnecting; your sessions keep running there.",
		);
	}
	return endpoint;
}
