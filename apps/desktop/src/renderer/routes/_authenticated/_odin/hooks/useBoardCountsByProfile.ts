import { useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { boardColumn } from "shared/board-column";
import { profileOf } from "shared/odin-profile";

export interface BoardCounts {
	needsYou: number;
	working: number;
}

/**
 * How many sessions are waiting on you, and how many are working, per profile.
 *
 * The board only ever shows one profile's cards, so a session that asked you a
 * question under the other set of accounts is invisible until you switch. This
 * counts the same "Needs you" and "Working" columns the board does, for every
 * profile at once, so the profile picker can say what's going on in each.
 *
 * ponytail: `odinTaskTitle` only, where the board also falls back to the
 * localStorage title mirror - that mirror is written for the active profile,
 * so it can't answer for the others anyway. Sessions launched before the pane
 * carried a title go uncounted; they age out.
 */
export function boardCountsByProfile(
	panes: Record<string, Pane>,
	alive: Set<string>,
): Map<string, BoardCounts> {
	const counts = new Map<string, BoardCounts>();
	for (const pane of Object.values(panes)) {
		if (pane.type !== "terminal" || !pane.odinTaskTitle) continue;
		const column = boardColumn(
			pane.status ?? "idle",
			alive.has(pane.id),
			pane.odinParked ?? false,
			false,
			pane.odinClosedIn,
		);
		if (column !== "permission" && column !== "working") continue;
		const profile = profileOf(pane.odinProfile);
		const count = counts.get(profile) ?? { needsYou: 0, working: 0 };
		if (column === "permission") count.needsYou++;
		else count.working++;
		counts.set(profile, count);
	}
	return counts;
}

/** "Work · 9 needs you · 2 working", or just "Work" when nothing is going on. */
export function profileLabel(name: string, counts?: BoardCounts): string {
	return [
		name,
		counts?.needsYou && `${counts.needsYou} needs you`,
		counts?.working && `${counts.working} working`,
	]
		.filter(Boolean)
		.join(" · ");
}

export function useBoardCountsByProfile(): Map<string, BoardCounts> {
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
		if (daemonSessions === undefined) return new Map<string, BoardCounts>();
		return boardCountsByProfile(
			panes,
			new Set(
				daemonSessions.sessions
					.filter((session) => session.isAlive)
					.map((session) => session.sessionId),
			),
		);
	}, [panes, daemonSessions]);
}
