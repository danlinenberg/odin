import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DEFAULT_PROFILE_ID } from "shared/odin-profile";

/**
 * Which set of accounts Odin is looking at right now.
 *
 * The main process owns the answer (it's the same file the credentials live
 * in), so this is one query the whole renderer shares.
 */

/** tRPC keys every query as `[[router, procedure], …]`. */
const PROFILE_SCOPED_ROUTERS = ["slack", "work", "notion", "connections"];

/**
 * Drop every feed that was fetched as the old profile — its rows came from a
 * different Slack, Jira and GitHub, and showing them for a second under the
 * new name is worse than showing a spinner. `reset`, not `invalidate`:
 * invalidated queries keep serving the stale data until the refetch lands.
 *
 * Scoped to the feed routers rather than the whole cache on purpose: resetting
 * the workspace and terminal queries too would remount every pane, which reads
 * as "Odin just restarted" to anyone with a session open.
 */
export function resetOdinFeeds(queryClient: QueryClient): void {
	void queryClient.resetQueries({
		predicate: (query) => {
			const router = (query.queryKey[0] as string[] | undefined)?.[0];
			return router !== undefined && PROFILE_SCOPED_ROUTERS.includes(router);
		},
	});
}

export function useOdinProfile() {
	const queryClient = useQueryClient();
	const query = electronTrpc.connections.profiles.useQuery(undefined, {
		// Profiles only change from inside this app, and every mutation refetches
		// — polling would just re-read a file forever.
		refetchOnWindowFocus: false,
	});
	const setActive = electronTrpc.connections.setActiveProfile.useMutation({
		onSuccess: () => resetOdinFeeds(queryClient),
	});

	const activeId = query.data?.activeId ?? DEFAULT_PROFILE_ID;
	return {
		activeId,
		profiles: query.data?.profiles ?? [],
		activeName:
			query.data?.profiles.find((p) => p.id === activeId)?.name ?? "Default",
		/** True until the first answer — views shouldn't filter on a guess. */
		isLoading: query.isLoading,
		switchTo: (id: string) => setActive.mutate({ id }),
		isSwitching: setActive.isPending,
	};
}
