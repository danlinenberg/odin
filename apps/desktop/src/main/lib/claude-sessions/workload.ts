/**
 * How much time went into agents, week by week.
 *
 * The transcript store is the only record that reaches back: the work ledger
 * starts when it landed, but `~/.claude/projects` holds every session ever run
 * on this machine, each entry stamped with a wall-clock time. So the history
 * is already on disk — it just has to be counted.
 *
 * Two different hours come out of that, and the gap between them is the point:
 * `agentHours` sums each session's own active time, so three agents running at
 * once bill three hours per hour; `yourHours` merges those spans, so the same
 * hour is counted once. One is what got done, the other is what it cost you.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	firstPrompt,
	projectsRoot,
	repoNameOf,
	type SessionPerson,
} from "./claude-sessions";

/** A stretch of wall-clock the session was moving, as `[start, end)`. */
export type Interval = [number, number];

/**
 * A quiet stretch longer than this means the session wasn't running, you'd
 * stepped away, or both — so it isn't time invested. Short enough to exclude a
 * coffee break, long enough to survive a slow build or a thinking pass.
 */
const IDLE_MS = 5 * 60 * 1000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface TranscriptScan {
	intervals: Interval[];
	activeMs: number;
	startedAt: number;
	endedAt: number;
	/** The checkout most of the session's commands ran in. */
	cwd: string | null;
	title: string | null;
	/** Timestamped entries — a rough size, used only to break ties. */
	entries: number;
}

/**
 * Consecutive timestamps welded into spans, breaking at every idle gap.
 * Timestamps needn't be sorted: transcripts are append-only, but a resumed
 * session can interleave, and an out-of-order pair would otherwise read as a
 * negative span.
 */
export function activeIntervals(
	timestamps: number[],
	idleMs = IDLE_MS,
): Interval[] {
	if (timestamps.length === 0) return [];
	const sorted = [...timestamps].sort((a, b) => a - b);
	const intervals: Interval[] = [];
	let start = sorted[0] as number;
	let previous = start;
	for (const at of sorted.slice(1)) {
		if (at - previous > idleMs) {
			if (previous > start) intervals.push([start, previous]);
			start = at;
		}
		previous = at;
	}
	if (previous > start) intervals.push([start, previous]);
	return intervals;
}

/** Overlapping or touching spans collapsed into one, so an hour counts once. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
	const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
	const merged: Interval[] = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

export function totalMs(intervals: Interval[]): number {
	return intervals.reduce((sum, [start, end]) => sum + (end - start), 0);
}

/**
 * Timestamps and working directory out of a raw transcript, by regex rather
 * than by parsing every line. The store runs to hundreds of megabytes and only
 * two fields are wanted from the body of it — `JSON.parse` per line costs
 * several times the whole scan. The title is the one field that does need
 * parsing, and `firstPrompt` reads only the head for it.
 */
export function scanTranscript(jsonl: string): TranscriptScan | null {
	const timestamps: number[] = [];
	const cwds = new Map<string, number>();
	const pattern = /"timestamp":"([^"]+)"|"cwd":"((?:[^"\\]|\\.)*)"/g;
	for (const match of jsonl.matchAll(pattern)) {
		if (match[1] !== undefined) {
			const at = Date.parse(match[1]);
			if (!Number.isNaN(at)) timestamps.push(at);
		} else if (match[2]) {
			const cwd = match[2].replace(/\\(.)/g, "$1");
			cwds.set(cwd, (cwds.get(cwd) ?? 0) + 1);
		}
	}
	if (timestamps.length === 0) return null;
	const intervals = activeIntervals(timestamps);
	// The busiest directory, not the last one: an agent's cwd hops between
	// repos as it works, so the final entry can be an unrelated lookup.
	const cwd =
		[...cwds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
		null;
	return {
		intervals,
		activeMs: totalMs(intervals),
		startedAt: Math.min(...timestamps),
		endedAt: Math.max(...timestamps),
		cwd,
		title: firstPrompt(jsonl),
		entries: timestamps.length,
	};
}

export interface SessionWork extends TranscriptScan {
	sessionId: string;
	project: string;
	person: string | null;
	source: string | null;
}

/** path → last scan, so a re-open only re-reads transcripts that changed. */
const cache = new Map<
	string,
	{ mtimeMs: number; bytes: number; scan: TranscriptScan | null }
>();

/**
 * Every transcript on this machine, scanned. Subagent side-conversations
 * (`<session>/subagents/*.jsonl`) are skipped — their time runs inside their
 * parent's and would be counted twice.
 */
export async function scanSessions({
	root = projectsRoot(),
	people = new Map<string, SessionPerson>(),
}: {
	root?: string;
	people?: Map<string, SessionPerson>;
} = {}): Promise<SessionWork[]> {
	let projects: string[];
	try {
		projects = (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const sessions: SessionWork[] = [];
	for (const project of projects) {
		let names: string[];
		try {
			names = await readdir(join(root, project));
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(root, project, name);
			let scan: TranscriptScan | null;
			try {
				const info = await stat(path);
				if (!info.isFile()) continue;
				const hit = cache.get(path);
				if (hit && hit.mtimeMs === info.mtimeMs && hit.bytes === info.size) {
					scan = hit.scan;
				} else {
					scan = scanTranscript(await readFile(path, "utf-8"));
					cache.set(path, {
						mtimeMs: info.mtimeMs,
						bytes: info.size,
						scan,
					});
				}
			} catch {
				continue; // deleted mid-scan, or unreadable
			}
			if (!scan) continue;
			const sessionId = name.slice(0, -".jsonl".length);
			const who = people.get(sessionId);
			sessions.push({
				...scan,
				sessionId,
				project,
				person: who?.person ?? null,
				source: who?.source ?? null,
			});
		}
	}
	return sessions;
}

export interface WeekRow {
	/** Monday 00:00 local, as an epoch ms. */
	start: number;
	agentHours: number;
	yourHours: number;
	sessions: number;
}

export interface TaskRow {
	sessionId: string;
	title: string;
	repo: string | null;
	person: string | null;
	source: string | null;
	hours: number;
	startedAt: number;
	/** Wall-clock from first entry to last, idle time included. */
	spanHours: number;
}

export interface Workload {
	sessions: number;
	agentHours: number;
	yourHours: number;
	/** Agent-hours per hour of yours. Null until there's an hour to divide by. */
	leverage: number | null;
	/** Oldest first, one row per week including the quiet ones. */
	weeks: WeekRow[];
	longest: TaskRow[];
	byRepo: { repo: string; hours: number; sessions: number }[];
	byPerson: { person: string; hours: number; sessions: number }[];
	/** Active minutes per hour of the day, local, index 0–23. */
	byHour: number[];
	/**
	 * The same minutes, kept per week instead of folded together: one row per
	 * week that has any, oldest first, each holding 168 cells indexed
	 * `weekday * 24 + hour` with Monday as weekday 0.
	 */
	heatmap: { start: number; minutes: number[] }[];
	busiestDay: { at: number; hours: number } | null;
	/** Sessions with a name attached — the rest are your own. */
	attributed: number;
	/** When the record starts, so a thin first week reads as thin, not idle. */
	since: number | null;
}

function hours(ms: number): number {
	return Math.round((ms / HOUR_MS) * 10) / 10;
}

/** Monday 00:00 local time for the week containing `at`. */
export function weekStart(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	// getDay() is Sunday-based; shift so Monday is 0 and Sunday is 6.
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	return date.getTime();
}

function dayStart(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** Split a span at local day boundaries, so an overnight run lands on both. */
function byDay(intervals: Interval[]): Map<number, number> {
	const days = new Map<number, number>();
	for (const [start, end] of intervals) {
		let at = start;
		while (at < end) {
			const day = dayStart(at);
			// +36h then back to midnight, so a DST day still steps exactly one day.
			const next = Math.min(end, dayStart(day + DAY_MS + DAY_MS / 2));
			days.set(day, (days.get(day) ?? 0) + (next - at));
			at = next;
		}
	}
	return days;
}

function tallyHours(
	sessions: SessionWork[],
	key: (session: SessionWork) => string | null,
	limit: number,
): { name: string; hours: number; sessions: number }[] {
	const totals = new Map<string, { ms: number; sessions: number }>();
	for (const session of sessions) {
		const name = key(session);
		if (!name) continue;
		const row = totals.get(name) ?? { ms: 0, sessions: 0 };
		row.ms += session.activeMs;
		row.sessions += 1;
		totals.set(name, row);
	}
	return [...totals]
		.map(([name, row]) => ({
			name,
			hours: hours(row.ms),
			sessions: row.sessions,
		}))
		.sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name))
		.slice(0, limit);
}

export function computeWorkload(
	sessions: SessionWork[],
	{
		now = Date.now(),
		weeks = 12,
		top = 8,
	}: { now?: number; weeks?: number; top?: number } = {},
): Workload {
	const all = sessions.filter((session) => session.activeMs > 0);
	const everything = all.flatMap((session) => session.intervals);
	const merged = mergeIntervals(everything);

	// A week's worth of rows, present or not — a gap in the history is itself
	// the answer to "how was last week", and a bar chart that silently drops
	// empty weeks makes a quiet fortnight look busy.
	const firstWeek = weekStart(now) - (weeks - 1) * 7 * DAY_MS;
	const buckets = new Map<
		number,
		{ agentMs: number; intervals: Interval[]; sessions: number }
	>();
	for (let index = 0; index < weeks; index++) {
		// Rebuilt from a date each step so DST can't drift the boundary.
		const start = weekStart(firstWeek + index * 7 * DAY_MS + DAY_MS / 2);
		buckets.set(start, { agentMs: 0, intervals: [], sessions: 0 });
	}
	for (const session of all) {
		// ponytail: a session counts in the week it started. A run that crosses
		// Monday midnight is rare enough to leave alone; split the intervals if
		// one ever shows up.
		const bucket = buckets.get(weekStart(session.startedAt));
		if (!bucket) continue;
		bucket.agentMs += session.activeMs;
		bucket.sessions += 1;
		bucket.intervals.push(...session.intervals);
	}

	const days = byDay(merged);
	const busiest = [...days].sort((a, b) => b[1] - a[1])[0];

	const byHour: number[] = Array.from({ length: 24 }, () => 0);
	// Same walk, banked twice: once folded across all weeks for the day clock,
	// once kept per week for the heatmap. Only weeks with a minute in them get
	// a row — an empty grid is cheaper to draw than to ship.
	const weekCells = new Map<number, number[]>();
	for (const [start, end] of merged) {
		let at = start;
		while (at < end) {
			const date = new Date(at);
			date.setMinutes(0, 0, 0);
			const next = Math.min(end, date.getTime() + HOUR_MS);
			const minutes = Math.round((next - at) / 60_000);
			byHour[date.getHours()] += minutes;
			const week = weekStart(at);
			let cells = weekCells.get(week);
			if (!cells) {
				cells = Array.from({ length: 7 * 24 }, () => 0);
				weekCells.set(week, cells);
			}
			cells[((date.getDay() + 6) % 7) * 24 + date.getHours()] += minutes;
			at = next;
		}
	}

	const yourMs = totalMs(merged);
	const agentMs = all.reduce((sum, session) => sum + session.activeMs, 0);

	const since = all.length
		? Math.min(...all.map((session) => session.startedAt))
		: null;
	// Weeks before the transcript store begins aren't quiet weeks, they're weeks
	// with no record — and a row of empty columns claiming otherwise was the
	// chart's least honest part. Drop them; the note says where the record starts.
	const firstRecorded = since === null ? null : weekStart(since);

	return {
		sessions: all.length,
		agentHours: hours(agentMs),
		yourHours: hours(yourMs),
		leverage: yourMs > 0 ? Math.round((agentMs / yourMs) * 10) / 10 : null,
		weeks: [...buckets]
			.sort((a, b) => a[0] - b[0])
			.filter(([start]) => firstRecorded === null || start >= firstRecorded)
			.map(([start, bucket]) => ({
				start,
				agentHours: hours(bucket.agentMs),
				yourHours: hours(totalMs(mergeIntervals(bucket.intervals))),
				sessions: bucket.sessions,
			})),
		longest: [...all]
			.sort((a, b) => b.activeMs - a.activeMs)
			.slice(0, top)
			.map((session) => ({
				sessionId: session.sessionId,
				title: session.title ?? `session ${session.sessionId.slice(0, 8)}`,
				repo: session.cwd ? repoNameOf(session.cwd) : null,
				person: session.person,
				source: session.source,
				hours: hours(session.activeMs),
				startedAt: session.startedAt,
				spanHours: hours(session.endedAt - session.startedAt),
			})),
		byRepo: tallyHours(
			all,
			(session) => (session.cwd ? repoNameOf(session.cwd) : null),
			top,
		).map(({ name, hours: h, sessions: count }) => ({
			repo: name,
			hours: h,
			sessions: count,
		})),
		byPerson: tallyHours(all, (session) => session.person, top).map(
			({ name, hours: h, sessions: count }) => ({
				person: name,
				hours: h,
				sessions: count,
			}),
		),
		byHour,
		heatmap: [...weekCells]
			.sort((a, b) => a[0] - b[0])
			.map(([start, minutes]) => ({ start, minutes })),
		busiestDay: busiest ? { at: busiest[0], hours: hours(busiest[1]) } : null,
		attributed: all.filter((session) => session.person).length,
		since,
	};
}
