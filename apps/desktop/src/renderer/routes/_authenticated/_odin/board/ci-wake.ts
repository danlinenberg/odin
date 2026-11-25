import type { FailedCheck } from "lib/trpc/routers/terminal/ci-failures";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fixConflictsMessage } from "./brief";

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
	/** The base branch's head when the session was last woken. */
	base?: string;
	/** When the session was last woken (ms). */
	at?: number;
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
	baseSha?: string | null;
	failedAt?: string | null;
}

export interface CiWake {
	url: string;
	sha: string;
	failed: string[];
	/** Which red run in a row this is, from 1. */
	run: number;
	base?: string;
	/** Same red run as before, woken again because the base branch moved. */
	baseMoved?: boolean;
}

/**
 * A run the session was woken for stays red on the same commit - often
 * because the base fails the same check and the session is waiting for that
 * fix. Once the base branch moves, it is woken again to merge it in, at most
 * this often.
 */
export const BASE_MOVED_GAP_MS = 60 * 60_000;

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
	now = Date.now(),
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
			const baseMoved =
				seen.wakes > 0 &&
				!!seen.base &&
				!!pr.baseSha &&
				seen.base !== pr.baseSha &&
				now - (seen.at ?? 0) >= BASE_MOVED_GAP_MS;
			if (baseMoved && seen.wakes < CI_RETRIES)
				wakes.push({
					url,
					sha: pr.headSha,
					failed: pr.failed,
					run: seen.wakes + 1,
					base: pr.baseSha ?? undefined,
					baseMoved: true,
				});
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
			base: pr.baseSha ?? undefined,
		});
	}
	return { next, wakes };
}

/** A red run the session was told about. */
export function woke(
	records: CiRedByPr,
	wake: CiWake,
	now = Date.now(),
): CiRedByPr {
	return {
		...records,
		[wake.url]: { sha: wake.sha, wakes: wake.run, base: wake.base, at: now },
	};
}

/** The message that wakes the session. */
export function ciWakeMessage(wake: CiWake, checks: FailedCheck[]): string {
	const pr = wake.url.match(/\/pull\/(\d+)/)?.[1] ?? "?";
	const named = checks.length
		? checks
		: wake.failed.map((name) => ({ name, link: null, log: null }));
	const parts = [
		...(wake.baseMoved
			? [
					`CI is still red on PR #${pr} on the same commit, and the base branch has moved since. If the failure came from the base, merge the base in now and push. Otherwise fix it.`,
				]
			: []),
		`CI failed on PR #${pr} (${wake.url}): ${named.map((c) => c.name).join(", ")}.`,
		...named.map((check) =>
			check.log
				? `${check.name} (${check.link}):\n\`\`\`\n${check.log}\n\`\`\``
				: `${check.name}: no log to show${check.link ? `, see ${check.link}` : ""}.`,
		),
		`Find the cause, fix it, push to the same branch, and watch CI again. This is red run ${wake.run} of ${CI_RETRIES} in a row that Odin sends you; after that it hands the PR back to the user.`,
		"First check whether the base branch fails the same check. If it does, this PR didn't break it: don't patch around it here. Look for a fix already on the base branch or an open PR for it, and update this branch once that fix is merged. If there is none, say so in one line.",
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
	/** Merge-conflict wakes, per session, per PR - see conflictWakePlan. */
	conflictsByPane: Record<string, ConflictsByPr>;
	/** Settings > Sessions: send the conflict prompt by itself. */
	fixConflicts: boolean;
	set: (paneId: string, records: CiRedByPr) => void;
	setConflicts: (paneId: string, records: ConflictsByPr) => void;
	setFixConflicts: (on: boolean) => void;
	prune: (paneIds: ReadonlySet<string>) => void;
}>()(
	persist(
		(set) => ({
			since: Date.now(),
			byPane: {},
			conflictsByPane: {},
			fixConflicts: true,
			set: (paneId, records) =>
				set((s) => ({ byPane: withRecords(s.byPane, paneId, records) })),
			setConflicts: (paneId, records) =>
				set((s) => ({
					conflictsByPane: withRecords(s.conflictsByPane, paneId, records),
				})),
			setFixConflicts: (fixConflicts) => set({ fixConflicts }),
			prune: (paneIds) =>
				set((s) => {
					const byPane = only(s.byPane, paneIds);
					const conflictsByPane = only(s.conflictsByPane ?? {}, paneIds);
					return byPane === s.byPane && conflictsByPane === s.conflictsByPane
						? s
						: { byPane, conflictsByPane };
				}),
		}),
		{ name: "odin-ci-wake" },
	),
);

function withRecords<R>(
	all: Record<string, Record<string, R>> | undefined,
	paneId: string,
	records: Record<string, R>,
): Record<string, Record<string, R>> {
	const rest = { ...all };
	if (Object.keys(records).length) rest[paneId] = records;
	else delete rest[paneId];
	return rest;
}

/** The same object when nothing goes, so the store doesn't change. */
function only<R>(
	all: Record<string, R>,
	paneIds: ReadonlySet<string>,
): Record<string, R> {
	const kept = Object.fromEntries(
		Object.entries(all).filter(([id]) => paneIds.has(id)),
	);
	return Object.keys(kept).length === Object.keys(all).length ? all : kept;
}

/** Sessions whose CI stayed red, or whose conflicts stayed, past the cap. */
export function gaveUpPanes(
	byPane: Record<string, Record<string, { gaveUp?: boolean }>> | undefined,
): string[] {
	return Object.entries(byPane ?? {})
		.filter(([, records]) => Object.values(records).some((r) => r.gaveUp))
		.map(([id]) => id);
}

/**
 * A session's open PR turned conflicting with its base: Odin sends it the
 * same prompt the brief's Fix merge conflicts sends, once per PR head + base
 * head pair - a new pair means the last merge didn't take, or the base moved
 * again. After `CONFLICT_RETRIES` tries in a row on one PR the card goes to
 * Needs you instead ("Conflicts still open").
 */
export const CONFLICT_RETRIES = 3;

export interface Conflicted {
	/** `<head sha>:<base sha>` the session was last sent the prompt for. */
	pair: string;
	/** Tries in a row on this PR. */
	tries: number;
	gaveUp?: boolean;
}

export type ConflictsByPr = Record<string, Conflicted>;

export interface ConflictPr {
	state: string;
	mine?: boolean | null;
	conflicting?: boolean;
	headSha?: string | null;
	baseSha?: string | null;
	base?: string | null;
}

export interface ConflictWake {
	url: string;
	pair: string;
	base: string | null;
	try: number;
}

/**
 * The session's conflict records after this poll, and the PRs to send the
 * prompt for. Only its open PRs count; one that stops conflicting ends the
 * streak. Like ciWakePlan, a wake is recorded by `conflictWoke` once the
 * message is in, so a session that can't take it now gets it next poll.
 */
export function conflictWakePlan(
	before: ConflictsByPr | undefined,
	states: Record<string, ConflictPr | null | undefined>,
): { next: ConflictsByPr; wakes: ConflictWake[] } {
	const next: ConflictsByPr = {};
	const wakes: ConflictWake[] = [];
	for (const [url, pr] of Object.entries(states)) {
		const seen = before?.[url];
		if (!pr) {
			// Unreadable this poll: keep what we knew.
			if (seen) next[url] = seen;
			continue;
		}
		if (pr.state !== "OPEN" || pr.mine === false || !pr.conflicting) continue;
		if (!pr.headSha) {
			if (seen) next[url] = seen;
			continue;
		}
		const pair = `${pr.headSha}:${pr.baseSha ?? ""}`;
		if (seen?.pair === pair || seen?.gaveUp) {
			next[url] = seen;
			continue;
		}
		const triesSoFar = seen?.tries ?? 0;
		if (triesSoFar >= CONFLICT_RETRIES) {
			next[url] = { pair, tries: triesSoFar, gaveUp: true };
			continue;
		}
		if (seen) next[url] = seen;
		wakes.push({ url, pair, base: pr.base ?? null, try: triesSoFar + 1 });
	}
	return { next, wakes };
}

/** A conflict the session was sent the prompt for. */
export function conflictWoke(
	records: ConflictsByPr,
	wake: ConflictWake,
): ConflictsByPr {
	return { ...records, [wake.url]: { pair: wake.pair, tries: wake.try } };
}

/** The brief's Fix merge conflicts prompt, word for word. */
export function conflictWakeMessage(wake: ConflictWake): string {
	return fixConflictsMessage(wake.url, wake.base);
}

/** Needs you or Done: the columns the board's merge-ready checks read. */
export function isMergeColumn(column: string | undefined): boolean {
	return column === "permission" || column === "review";
}

/**
 * The columns the CI and conflict wakes watch. Besides Needs you and Done:
 * Working, whose message waits until Claude sits idle at its prompt, and Idle,
 * where a `/loop` session between ticks and a session that died after its
 * turn sit. Not a card you dragged to Idle yourself.
 */
export function wakesColumn(column: string, parked: boolean): boolean {
	return (
		isMergeColumn(column) ||
		column === "working" ||
		(column === "idle" && !parked)
	);
}
