import type { AppRouter } from "@odin/host-service";
import { createTRPCClient, httpLink } from "@trpc/client";
import superjson from "superjson";

/**
 * This server's own host-service API, over loopback - how the schedulers start,
 * list and stop sessions the same way the laptop does through its tunnel.
 */
export type HostApi = ReturnType<typeof createTRPCClient<AppRouter>>;

let client: HostApi | null = null;

export function configureHostApi(secret: string): void {
	const port = process.env.HOST_SERVICE_PORT;
	client = createTRPCClient<AppRouter>({
		links: [
			httpLink({
				url: `http://127.0.0.1:${port}/trpc`,
				transformer: superjson,
				headers: () => ({ Authorization: `Bearer ${secret}` }),
			}),
		],
	});
}

export function hostApi(): HostApi {
	if (!client) throw new Error("The host-service API is not configured yet");
	return client;
}
