import type { PaneStatus } from "./tabs-types";

/**
 * The iPhone lock screen's count (apps/mobile/ios/App/OdinWidget): sessions
 * whose turn ended in the last hour and still wait on you - in Needs you or
 * Final Review. One you answered went back to Working and drops off. The
 * widget counts each one down on its own an hour after it ended, so the
 * window is also in EndedStore.swift.
 */
export const RECENTLY_ENDED_MS = 60 * 60_000;

const WAITING: PaneStatus[] = ["permission", "review"];

/** Newest first. */
export function recentlyEnded<
	T extends { column: string; statusAt?: number | null },
>(sessions: T[], now = Date.now()): (T & { statusAt: number })[] {
	return sessions
		.filter(
			(s): s is T & { statusAt: number } =>
				WAITING.includes(s.column as PaneStatus) &&
				typeof s.statusAt === "number" &&
				now - s.statusAt < RECENTLY_ENDED_MS,
		)
		.sort((a, b) => b.statusAt - a.statusAt);
}
