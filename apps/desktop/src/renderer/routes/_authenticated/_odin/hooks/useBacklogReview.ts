import { useCallback, useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DEFAULT_PROFILE_ID } from "shared/odin-profile";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { keepDropped, type SweptRow } from "../review/verdicts";
import { useBacklog } from "./builtin-automations";
import { useOdinFeeds } from "./useOdinFeeds";
import { useOdinProfile } from "./useOdinProfile";

/** A row dropped from Review, as it was swept, and when. */
export type DroppedRow = SweptRow & { droppedAt: number };

// ponytail: fixed cap on drops the sweep no longer lists - 500, since one
// sweep can auto-drop 200+ and a 100 cap hid most of them from Undo. Ones it still lists
// are always kept (see keepDropped), or a reload would put them back.
const DROPPED_KEPT = 500;

/** Your Keep beats the sweep's DROP - on Review and on every card's pill. */
function keptAsKeep(swept: SweptRow[], kept: string[]): SweptRow[] {
	const set = new Set(kept);
	return swept.map((row) =>
		set.has(row.key) && row.verdict !== "KEEP"
			? { ...row, verdict: "KEEP", evidence: "You kept this" }
			: row,
	);
}

/** One profile's Review: its last sweep and what you decided on it. */
export interface ProfileReview {
	swept: SweptRow[];
	/** When the sweep ran, ms. */
	sweptAt: number | null;
	/** What was dropped from Review, newest first. Not cleared by a sweep; see keepDropped. */
	dropped: DroppedRow[];
	/** Rows you pressed Keep on. They stay KEEP through later sweeps. */
	kept: string[];
}

const EMPTY: ProfileReview = {
	swept: [],
	sweptAt: null,
	dropped: [],
	kept: [],
};

/**
 * v0 had one sweep for the whole app. It was swept under whichever profile was
 * live; default is the one every install has, and the one that existed before
 * profiles did.
 */
export function migrateReview(persisted: unknown, version: number): unknown {
	if (version >= 1) return persisted;
	const old = (persisted ?? {}) as Partial<ProfileReview> & {
		sweepEveryHours?: number;
	};
	return {
		sweepEveryHours: old.sweepEveryHours ?? 1,
		profiles: {
			[DEFAULT_PROFILE_ID]: {
				swept: old.swept ?? [],
				sweptAt: old.sweptAt ?? null,
				dropped: old.dropped ?? [],
				kept: old.kept ?? [],
			},
		},
	};
}

/**
 * The last sweep's answers, one set per profile - a sweep reads one profile's
 * Slack, Jira and GitHub, so its rows mean nothing under another.
 *
 * Kept here rather than in the screen's state so leaving Review and coming
 * back doesn't mean sweeping again, and persisted so a reload doesn't either.
 * Small and fixed-size per profile: one row per backlog item, replaced whole
 * by the next sweep.
 *
 * ponytail: a deleted profile's slice stays behind - one backlog's worth.
 * Drop it alongside deleteProfile if that ever adds up.
 */
export const useBacklogReview = create<{
	profiles: Record<string, ProfileReview | undefined>;
	/** A sweep is in flight - the button's or the clock's. Not persisted. */
	sweeping: boolean;
	/** How often the shell sweeps on its own, hours. 0 turns the clock off. */
	sweepEveryHours: number;
	keep: (profileId: string, key: string) => void;
	noteDropped: (profileId: string, row: SweptRow) => void;
	unnoteDropped: (profileId: string, key: string) => void;
	record: (profileId: string, swept: SweptRow[]) => void;
	setSweepEveryHours: (hours: number) => void;
}>()(
	persist(
		(set) => {
			/** Rewrite one profile's slice, leaving the others alone. */
			const update = (
				profileId: string,
				next: (review: ProfileReview) => Partial<ProfileReview>,
			) =>
				set(({ profiles }) => {
					const review = profiles[profileId] ?? EMPTY;
					return {
						profiles: {
							...profiles,
							[profileId]: { ...review, ...next(review) },
						},
					};
				});
			return {
				profiles: {},
				sweeping: false,
				sweepEveryHours: 1,
				keep: (profileId, key) =>
					update(profileId, ({ swept, kept }) => ({
						kept: [...kept.filter((k) => k !== key), key],
						swept: keptAsKeep(swept, [key]),
					})),
				noteDropped: (profileId, row) =>
					update(profileId, ({ dropped, swept }) => ({
						dropped: keepDropped(
							[
								{ ...row, droppedAt: Date.now() },
								...dropped.filter((d) => d.key !== row.key),
							],
							swept,
							DROPPED_KEPT,
						),
					})),
				unnoteDropped: (profileId, key) =>
					update(profileId, ({ dropped }) => ({
						dropped: dropped.filter((d) => d.key !== key),
					})),
				record: (profileId, fresh) =>
					update(profileId, ({ dropped, kept }) => {
						// ponytail: kept is bounded by pruning to what the sweep still lists.
						const listed = new Set(fresh.map((row) => row.key));
						const stillKept = kept.filter((key) => listed.has(key));
						const swept = keptAsKeep(fresh, stillKept);
						return {
							swept,
							kept: stillKept,
							sweptAt: Date.now(),
							dropped: keepDropped(dropped, swept, DROPPED_KEPT),
						};
					}),
				setSweepEveryHours: (sweepEveryHours) => set({ sweepEveryHours }),
			};
		},
		{
			name: "odin-backlog-review",
			version: 1,
			migrate: (persisted, version) =>
				migrateReview(persisted, version) as never,
			partialize: ({ profiles, sweepEveryHours }) => ({
				profiles,
				sweepEveryHours,
			}),
		},
	),
);

/**
 * The active profile's Review - the only way a screen reads it. Empty until
 * the profile is known, so a reload inside another profile doesn't flash the
 * default one's rows first.
 */
export function useReview<T>(select: (review: ProfileReview) => T): T {
	const { activeId, isLoading } = useOdinProfile();
	return useBacklogReview((s) =>
		select(isLoading ? EMPTY : (s.profiles[activeId] ?? EMPTY)),
	);
}

/**
 * Every backlog row checked against the system it came from, answers into the
 * store. Resolves true when a sweep actually ran. Throws on failure.
 */
export function useSweepBacklog(): () => Promise<boolean> {
	const backlog = useBacklog();
	const { reactions, jira, pulls, notion } = useOdinFeeds();
	const { activeId, isLoading: profileLoading } = useOdinProfile();
	// A feed still on its first answer is missing from the backlog only
	// because nothing has arrived - sweeping then judges a backlog with no
	// Slack rows in it, as the first tick after every restart did.
	const loading =
		profileLoading || [reactions, jira, pulls, notion].some((q) => q.isLoading);
	const sweep = electronTrpc.backlogReview.sweep.useMutation();
	return useCallback(async () => {
		const store = useBacklogReview.getState();
		if (store.sweeping || loading || backlog.length === 0) return false;
		// The profile the backlog was read under. A switch while the sweep is out
		// mustn't file these answers under the profile you switched to.
		const profileId = activeId;
		useBacklogReview.setState({ sweeping: true });
		try {
			const { rows: answers } = await sweep.mutateAsync({ items: backlog });
			// The answer carries the key, so what's rendered is the row as it was
			// swept - an item added while the sweep ran simply isn't in the list.
			const byKey = new Map(answers.map((row) => [row.key, row]));
			store.record(
				profileId,
				backlog.flatMap((item) => {
					const answer = byKey.get(item.key);
					if (!answer) return [];
					return [
						{
							key: item.key,
							source: item.source,
							title: item.title,
							...(item.url ? { url: item.url } : {}),
							verdict: answer.verdict,
							evidence: answer.evidence,
						},
					];
				}),
			);
			// A DROP is a suggestion: it waits on Review for you to drop it.
			return true;
		} finally {
			useBacklogReview.setState({ sweeping: false });
		}
	}, [backlog, loading, activeId, sweep.mutateAsync]);
}

/**
 * The sweep on a clock. Mounted in the shell, like the automation runner: a
 * schedule that only runs while Review is open isn't one. Checks once a
 * minute and sweeps when the active profile's last answers are older than the
 * interval set in Settings → Backlog, so a relaunch after lunch sweeps straight
 * away, a reload doesn't sweep twice, and a profile you've just switched to is
 * swept on its own clock. A new interval applies on the next tick.
 */
export function usePeriodicSweep(): void {
	const sweepBacklog = useSweepBacklog();
	const { activeId } = useOdinProfile();
	// The interval reads the latest closure, not the one it was set up with.
	const latest = useRef({ sweepBacklog, activeId });
	latest.current = { sweepBacklog, activeId };
	useEffect(() => {
		// A failing sweep waits the full interval too, not a retry a minute. A
		// tick that didn't sweep - feeds still loading, one already running -
		// isn't a try, or a restart's first tick would push the sweep an hour.
		let triedAt = 0;
		const tick = () => {
			const { profiles, sweepEveryHours } = useBacklogReview.getState();
			if (sweepEveryHours <= 0) return;
			const sweptAt = profiles[latest.current.activeId]?.sweptAt;
			const last = Math.max(sweptAt ?? 0, triedAt);
			if (Date.now() - last < sweepEveryHours * 3_600_000) return;
			latest.current.sweepBacklog().catch((error) => {
				triedAt = Date.now();
				console.warn("[review] periodic sweep failed", error);
			});
		};
		const id = setInterval(tick, 60_000);
		return () => clearInterval(id);
	}, []);
}
