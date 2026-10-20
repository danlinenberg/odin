import {
	createTRPCProxyClient,
	httpLink,
	TRPCClientError,
	type TRPCLink,
} from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "lib/trpc/routers";
import type { OdinCoreRouter } from "main/odin-core/router";
import { isRemoteCorePath, REMOTE_CORE_PATH } from "shared/remote-core";
import superjson from "superjson";

/**
 * While sessions run on a remote server, Odin's connections run there too
 * (main/odin-core): their credentials, token refresh and fetching live on the
 * server, so the feeds and automations keep working with the laptop shut.
 * These links send the connection namespaces (connections, work, slack,
 * notion, backlogReview, workLog) to it instead of to this laptop's main.
 *
 * Set by RemoteCoreTarget (LocalHostServiceProvider). In remote mode with the
 * tunnel down, calls fail rather than quietly reading the laptop's stale
 * credentials.
 */
let remoteMode = false;
/** Whether main has said yet which mode this is. */
let modeKnown = false;
let target: { url: string; secret: string } | null = null;
const listeners = new Set<() => void>();

export function setRemoteCoreTarget(
	modeOrUnknown: boolean | undefined,
	next: { url: string; secret: string } | null,
): void {
	if (modeOrUnknown !== undefined) modeKnown = true;
	const mode = modeOrUnknown === true;
	const changed =
		mode !== remoteMode ||
		next?.url !== target?.url ||
		next?.secret !== target?.secret;
	remoteMode = mode;
	target = next;
	if (changed) for (const listener of listeners) listener();
}

/** Called when the connections' home changes, so their queries refetch there. */
export function onRemoteCoreTargetChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Where the server's Odin core answers right now, or null (local mode, or offline). */
export function getRemoteCoreTarget(): { url: string; secret: string } | null {
	return remoteMode ? target : null;
}

/**
 * Whether sessions (and so the schedulers that start them) live on a remote
 * server - true while it's offline too. The window's own schedulers stand
 * down then: the server runs them (main/odin-core/scheduler.ts).
 */
export function isRemoteCoreMode(): boolean {
	return remoteMode;
}

/**
 * Whether the window's own schedulers (automations, Night Agent, Slack
 * auto-launch, the queue) should run: only once main has said this is local
 * mode. Before it answers, a tick could start on the laptop what the server
 * starts too.
 */
export function runsLocalSchedulers(): boolean {
	return modeKnown && !remoteMode;
}

/** The server's Odin core, typed - for the calls that aren't desktop routers. */
export function remoteCoreClient() {
	const current = getRemoteCoreTarget();
	if (!current) return null;
	return createTRPCProxyClient<OdinCoreRouter>({
		links: [
			httpLink({
				url: `${current.url}${REMOTE_CORE_PATH}`,
				transformer: superjson,
				headers: () => ({ Authorization: `Bearer ${current.secret}` }),
			}),
		],
	});
}
export function routesToRemoteCore(path: string): boolean {
	return remoteMode && isRemoteCorePath(path);
}

export function remoteCoreLink(): TRPCLink<AppRouter> {
	return (runtime) => {
		let cached: {
			key: string;
			link: ReturnType<TRPCLink<AppRouter>>;
		} | null = null;
		return (opts) => {
			const current = target;
			if (!current) {
				return observable((observer) => {
					observer.error(
						TRPCClientError.from(
							new Error(
								"The remote server is not connected right now. Your connections run there; Odin keeps reconnecting.",
							),
						),
					);
				});
			}
			const key = `${current.url}\n${current.secret}`;
			if (cached?.key !== key) {
				cached = {
					key,
					link: httpLink<AppRouter>({
						url: `${current.url}${REMOTE_CORE_PATH}`,
						transformer: superjson,
						headers: () => ({ Authorization: `Bearer ${current.secret}` }),
					})(runtime),
				};
			}
			return cached.link(opts);
		};
	};
}
