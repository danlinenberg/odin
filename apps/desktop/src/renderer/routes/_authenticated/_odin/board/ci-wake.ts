import type { FailedCheck } from "lib/trpc/routers/terminal/ci-failures";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * CI turned red on a session's PR after the agent stopped: Odin sends the
 * session the failed checks and their logs, so it fixes them and pushes
 * again. Once per red run (a run is a head commit), and after
 * `CI_RETRIES` red runs in a row the card goes to Needs you instead.
 */

export const CI_RETRIES = 3;

/** What one PR's CI has done so far, for one session. */
export interface CiRed {
	/** The head commit last seen red, or last seen at all. */
	sha: string;
	/** Red runs in a row the session was woken for. */
	wakes: number;
	/** Red past the cap: the card waits for you. */
	gaveUp?: boolean;
}

export type CiRedByPr = Record<string, CiRed>;

/** One PR's state as the board's poll has it. */
export interface CiPr {
	state: string;
	mine?: boolean | null;
	failed?: string[];
	pending?: string[];
	headSha?: string | null;
	failedAt?: string | null;
}

export interface CiWake {
	url: string;
	sha: string;
	failed: string[];
	/** Which red run in a row this is, from 1. */
	run: number;
}

/**
 * The session's PR records after this poll, and the red runs to wake it for.
 * Only your open PRs count. A run still going changes nothing; a green one
 * ends the streak. A red one counts once: seen before (same head commit) it is
 * left alone, and one that finished before `since` (when this feature first
 * ran here) is only recorded - turning it on must not wake every session
 * with an old red PR.
 */
export function ciWakePlan(
	before: CiRedByPr | undefined,
	states: Record<string, CiPr | null | undefined>,
	since: number,
): { next: CiRedByPr; wakes: CiWake[] } {
	const next: CiRedByPr = {};
	const wakes: CiWake[] = [];
	for (const [url, pr] of Object.entries(states)) {
		const seen = before?.[url];
		if (!pr) {
			// Unreadable this poll: keep what we knew.
			if (seen) next[url] = seen;
			continue;
		}
		if (pr.state !== "OPEN" || pr.mine === false || !pr.headSha) continue;
		if (pr.pending?.length) {
			if (seen) next[url] = seen;
			continue;
		}
		if (!pr.failed?.length) continue;
		if (seen?.sha === pr.headSha) {
			next[url] = seen;
			continue;
		}
		const finished = pr.failedAt ? Date.parse(pr.failedAt) : Number.NaN;
		if (!seen && !(finished >= since)) {
			next[url] = { sha: pr.headSha, wakes: 0 };
			continue;
		}
		const wakesSoFar = seen?.wakes ?? 0;
		if (wakesSoFar >= CI_RETRIES) {
			next[url] = { sha: pr.headSha, wakes: wakesSoFar, gaveUp: true };
			continue;
		}
		// Recorded by `woke` once the message is in, so a session that can't
		// take it now is tried again on the next poll.
		if (seen) next[url] = seen;
		wakes.push({
			url,
			sha: pr.headSha,
			failed: pr.failed,
			run: wakesSoFar + 1,
		});
	}
	return { next, wakes };
}

/** A red run the session was told about. */
export function woke(records: CiRedByPr, wake: CiWake): CiRedByPr {
	return { ...records, [wake.url]: { sha: wake.sha, wakes: wake.run } };
}

/** The message that wakes the session. */
export function ciWakeMessage(wake: CiWake, checks: FailedCheck[]): string {
	const pr = wake.url.match(/\/pull\/(\d+)/)?.[1] ?? "?";
	const named = checks.length
		? checks
		: wake.failed.map((name) => ({ name, link: null, log: null }));
	const parts = [
		`CI failed on PR #${pr} (${wake.url}): ${named.map((c) => c.name).join(", ")}.`,
		...named.map((check) =>
			check.log
				? `${check.name} (${check.link}):\n\`\`\`\n${check.log}\n\`\`\``
				: `${check.name}: no log to show${check.link ? `, see ${check.link}` : ""}.`,
		),
		`Find the cause, fix it, push to the same branch, and watch CI again. This is red run ${wake.run} of ${CI_RETRIES} in a row that Odin sends you; after that it hands the PR back to the user.`,
	];
	return parts.join("\n\n");
}

/**
 * Per session, per PR. Bounded by the board: `prune` drops sessions that are
 * gone (Done, closed), and a PR leaves once it merges, closes or goes green.
 */
export const useCiWake = create<{
	/** When this feature first ran on this computer (ms). */
	since: number;
	byPane: Record<string, CiRedByPr>;
	set: (paneId: string, records: CiRedByPr) => void;
	prune: (paneIds: ReadonlySet<string>) => void;
}>()(
	persist(
		(set) => ({
			since: Date.now(),
			byPane: {},
			set: (paneId, records) =>
				set((s) => {
					const rest = { ...s.byPane };
					if (Object.keys(records).length) rest[paneId] = records;
					else delete rest[paneId];
					return { byPane: rest };
				}),
			prune: (paneIds) =>
				set((s) => {
					const kept = Object.fromEntries(
						Object.entries(s.byPane).filter(([id]) => paneIds.has(id)),
					);
					return Object.keys(kept).length === Object.keys(s.byPane).length
						? s
						: { byPane: kept };
				}),
		}),
		{ name: "odin-ci-wake" },
	),
);

/** Sessions whose CI stayed red past the cap. */
export function gaveUpPanes(byPane: Record<string, CiRedByPr>): string[] {
	return Object.entries(byPane)
		.filter(([, records]) => Object.values(records).some((r) => r.gaveUp))
		.map(([id]) => id);
}
