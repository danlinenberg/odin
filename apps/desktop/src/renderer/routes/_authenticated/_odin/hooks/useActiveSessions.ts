import { useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { type ActiveSession, activeSessions } from "shared/active-sessions";
import { useOdinProfile } from "./useOdinProfile";

export type { ActiveSession };

export function useActiveSessions(): ActiveSession[] {
	const panes = useTabsStore((state) => state.panes);
	const { activeId, isLoading } = useOdinProfile();
	// Same 5s poll the board and the profile picker run — one shared query.
	const { data: daemonSessions } =
		electronTrpc.terminal.listDaemonSessions.useQuery(undefined, {
			refetchInterval: 5_000,
		});

	return useMemo(() => {
		// No poll answer yet, or no profile yet: show nothing rather than a list
		// that's about to change under you.
		if (daemonSessions === undefined || isLoading) return [];
		return activeSessions(
			panes,
			new Set(
				daemonSessions.sessions
					.filter((session) => session.isAlive)
					.map((session) => session.sessionId),
			),
			activeId,
		);
	}, [panes, daemonSessions, activeId, isLoading]);
}
