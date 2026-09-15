import { useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { boardColumn } from "shared/board-column";
import { profileOf } from "shared/odin-profile";

/**
 * How many sessions are waiting on you, per profile.
 *
 * The board only ever shows one profile's cards, so a session that asked you a
 * question under the other set of accounts is invisible until you switch. This
 * counts the same "Needs you" column the board does, for every profile at once,
 * so the profile picker can say which one has something waiting.
 *
 * ponytail: `odinTaskTitle` only, where the board also falls back to the
 * localStorage title mirror — that mirror is written for the active profile,
 * so it can't answer for the others anyway. Sessions launched before the pane
 * carried a title go uncounted; they age out.
 */
export function needsYouByProfile(
	panes: Record<string, Pane>,
	alive: Set<string>,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const pane of Object.values(panes)) {
		if (pane.type !== "terminal" || !pane.odinTaskTitle) continue;
		const column = boardColumn(
			pane.status ?? "idle",
			alive.has(pane.id),
			pane.odinParked ?? false,
		);
		if (column !== "permission") continue;
		const profile = profileOf(pane.odinProfile);
		counts.set(profile, (counts.get(profile) ?? 0) + 1);
	}
	return counts;
}

export function useNeedsYouByProfile(): Map<string, number> {
	const panes = useTabsStore((state) => state.panes);
	// Same poll the board runs (shared query cache, so this costs nothing extra):
	// a dead session can't be waiting on you, whatever its status froze at.
	const { data: daemonSessions } =
		electronTrpc.terminal.listDaemonSessions.useQuery(undefined, {
			refetchInterval: 5_000,
		});

	return useMemo(() => {
		// No poll answer yet: every session would read as dead, so count nothing
		// rather than flash a number that's about to change.
		if (daemonSessions === undefined) return new Map<string, number>();
		return needsYouByProfile(
			panes,
			new Set(
				daemonSessions.sessions
					.filter((session) => session.isAlive)
					.map((session) => session.sessionId),
			),
		);
	}, [panes, daemonSessions]);
}
