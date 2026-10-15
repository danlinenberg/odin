import { createTRPCProxyClient, splitLink } from "@trpc/client";
import type { AppRouter } from "lib/trpc/routers";
import superjson from "superjson";
import { ipcLink } from "trpc-electron/renderer";
import { electronTrpc } from "./electron-trpc";
import { remoteCoreLink, routesToRemoteCore } from "./remote-core-link";
import { sessionIdLink } from "./session-id-link";

/** IPC to main, except the connection namespaces in remote mode (remote-core-link). */
function links() {
	return [
		sessionIdLink(),
		splitLink<AppRouter>({
			condition: (op) => routesToRemoteCore(op.path),
			true: remoteCoreLink(),
			false: ipcLink({ transformer: superjson }),
		}),
	];
}

/** Electron tRPC React client for React hooks (used by ElectronTRPCProvider). */
export const electronReactClient = electronTrpc.createClient({
	links: links(),
});

/** Electron tRPC proxy client for imperative calls from stores/utilities. */
export const electronTrpcClient = createTRPCProxyClient<AppRouter>({
	links: links(),
});
