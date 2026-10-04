/**
 * How much time went into agents, week by week.
 *
 * The transcript store is the only record that reaches back: the work ledger
 * starts when it landed, but `~/.claude/projects` holds every session ever run
 * on this machine, each entry stamped with a wall-clock time. So the history
 * is already on disk - it just has to be counted.
 *
 * Two different hours come out of that, and the ratio between them is the point:
 * `agentHours` is the agents' own work (each session's active time less the
 * time it waited on you, plus its subagents - three at once bill three hours);
 * `yourHours` is your reading-and-typing time before each prompt you sent. One
 * is what got done, the other is what it cost you.
 */

import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "main/lib/app-environment";
import {
	firstPrompt,
	projectsRoot,
	repoOfDir,
	type SessionPerson,
} from "./claude-sessions";

/**
 * Your time in a session: for each prompt you typed, the gap since the agent
 * last wrote - reading its answer and writing yours - capped at the idle gap,
 * so a prompt sent after lunch counts five minutes, not the lunch. An
 * estimate, and a floor: it can't see you reading while the agent works.
 */
export function humanIntervals(jsonl: string, sorted: number[]): Interval[] {
	const out: Interval[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.includes('"promptSource":"')) continue;
		let entry: {
			promptSource?: string;
			isSidechain?: boolean;
			timestamp?: string;
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.isSidechain || !TYPED_SOURCES.has(entry.promptSource ?? ""))
			continue;
		const at = Date.parse(entry.timestamp ?? "");
		if (Number.isNaN(at)) continue;
		// The last entry before this prompt - the agent's reply you were reading.
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((sorted[mid] as number) < at) lo = mid + 1;
			else hi = mid;
		}
		const before = sorted[lo - 1];
		if (before === undefined) continue; // the opening prompt: no reply to read
		out.push([at - Math.min(at - before, IDLE_MS), at]);
	}
	return out;
}

/** `promptSource` values that mean a person typed it (see claude-sessions). */
const TYPED_SOURCES = new Set(["typed", "queued", "suggestion_accepted"]);

/** A stretch of wall-clock the session was moving, as `[start, end)`. */
export type Interval = [number, number];

/**
 * A quiet stretch longer than this means the session wasn't running, you'd
 * stepped away, or both - so it isn't time invested. Short enough to exclude a
 * coffee break, long enough to survive a slow build or a thinking pass.
 */
const IDLE_MS = 5 * 60 * 1000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface TranscriptScan {
	intervals: Interval[];
	activeMs: number;
	/** Your reading-and-typing time, see `humanIntervals`. */
	yours: Interval[];
	startedAt: number;
	endedAt: number;
	/** The checkout most of the session's commands ran in. */
	cwd: string | null;
	/** Every directory the session ran in, with how many entries each. */
	dirs: [string, number][];
	title: string | null;
	/** PRs the session opened with `gh pr create`, as urls. */
	prs: string[];
	/** When each of `prs` was opened, same order; null if unstamped. */
	prAt: (number | null)[];
	/** The opening message, clipped. */
	opening: string | null;
	/** Timestamped entries - a rough size, used only to break ties. */
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

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/**
 * PRs a transcript opened: the url `gh pr create` printed. Only lines that can
 * hold one are parsed, so this stays cheap next to the regex scan.
 */
export function openedPrs(jsonl: string): { url: string; at: number | null }[] {
	const creates = new Set<string>();
	const prs = new Map<string, number | null>();
	for (const line of jsonl.split("\n")) {
		if (!line.includes("gh pr create") && !line.includes("/pull/")) continue;
		let entry: {
			isSidechain?: boolean;
			timestamp?: string;
			message?: { content?: unknown };
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const content = entry.message?.content;
		if (entry.isSidechain || !Array.isArray(content)) continue;
		for (const block of content) {
			if (
				block?.type === "tool_use" &&
				/\bgh pr create\b/.test(String(block.input?.command ?? ""))
			)
				creates.add(block.id);
			else if (block?.type === "tool_result" && creates.has(block.tool_use_id))
				for (const url of JSON.stringify(block.content).match(PR_URL) ?? [])
					if (!prs.has(url))
						prs.set(url, entry.timestamp ? Date.parse(entry.timestamp) : null);
		}
	}
	return [...prs].map(([url, at]) => ({ url, at }));
}

/**
 * The first sentence of the session's opening message, whoever wrote it. An
 * automation's `claude -p` run has no typed prompt for `firstPrompt` to find,
 * but its brief ("Triage one bug report from…") still says what it was for.
 */
export function openingLine(jsonl: string): string | null {
	const first = openingText(jsonl)
		?.split(/(?<=[.!?])\s|\n/)[0]
		?.trim();
	if (!first) return null;
	return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** The session's opening message, clipped - a row's hover description. */
export function openingText(
	jsonl: string,
	max = 600,
	headBytes = 200_000,
): string | null {
	for (const line of jsonl.slice(0, headBytes).split("\n")) {
		if (!line.includes('"type":"user"')) continue;
		let entry: {
			type?: string;
			isSidechain?: boolean;
			message?: { content?: unknown };
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "user" || entry.isSidechain) continue;
		const content = entry.message?.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.find((block) => block?.type === "text")?.text
					: null;
		const clean = String(text ?? "").trim();
		if (clean)
			return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
	}
	return null;
}

/**
 * Timestamps and working directory out of a raw transcript, by regex rather
 * than by parsing every line. The store runs to hundreds of megabytes and only
 * two fields are wanted from the body of it - `JSON.parse` per line costs
 * several times the whole scan. The title is the one field that does need
 * parsing, and `firstPrompt` reads only the head for it.
 */
export function scanTranscript(jsonl: string): TranscriptScan | null {
	const timestamps: number[] = [];
	const cwds = new Map<string, number>();
	let aiTitle: string | null = null;
	const pattern =
		/"timestamp":"([^"]+)"|"cwd":"((?:[^"\\]|\\.)*)"|"aiTitle":("(?:[^"\\]|\\.)*")/g;
	for (const match of jsonl.matchAll(pattern)) {
		if (match[3] !== undefined) {
			// Claude Code retitles as a session moves on; the latest name wins.
			aiTitle = JSON.parse(match[3]) as string;
		} else if (match[1] !== undefined) {
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
		yours: humanIntervals(
			jsonl,
			[...timestamps].sort((a, b) => a - b),
		),
		startedAt: Math.min(...timestamps),
		endedAt: Math.max(...timestamps),
		cwd,
		dirs: [...cwds],
		// Claude Code's own name for the session reads like a task; the first
		// prompt is the fallback for sessions too old or short to have one.
		// A session opened by a slash command (a scheduled `/gdpr`) has no
		// typed prompt; its command is still a better name than an id.
		title:
			aiTitle ||
			firstPrompt(jsonl) ||
			/<command-name>(\/[^<]+)<\/command-name>/.exec(jsonl)?.[1] ||
			openingLine(jsonl),
		opening: openingText(jsonl),
		...(() => {
			const opened = openedPrs(jsonl);
			return {
				prs: opened.map((pr) => pr.url),
				prAt: opened.map((pr) => pr.at),
			};
		})(),
		entries: timestamps.length,
	};
}

export interface SessionWork extends TranscriptScan {
	sessionId: string;
	project: string;
	/** The repo `cwd` belongs to; null when the session ran outside one. */
	repo: string | null;
	/** Active spans of the session's subagents, each counted on its own. */
	subagents: Interval[];
	/** When its pane was open and you were there - see `attention.ts`. */
	attended: Interval[];
	person: string | null;
	source: string | null;
}

/** path → last scan, so a re-open only re-reads transcripts that changed. */
const cache = new Map<
	string,
	{ mtimeMs: number; bytes: number; scan: TranscriptScan | null }
>();

/** dir → repo name; a walk up the tree per directory, done once. */
const repos = new Map<string, string | null>();

function repoOf(dir: string): string | null {
	if (!repos.has(dir)) repos.set(dir, repoOfDir(dir));
	return repos.get(dir) ?? null;
}

/**
 * The repo a session worked in: every directory it ran in, tallied by the
 * repo it belongs to. Tallying rather than taking the busiest folder is what
 * lets a session started in `~/dev` that did its work in a clone land on that
 * clone. Nothing in a repo - a general task - is null.
 */
export function repoForDirs(
	dirs: [string, number][],
	resolve: (dir: string) => string | null = repoOf,
): string | null {
	const votes = new Map<string, number>();
	for (const [dir, count] of dirs) {
		const repo = resolve(dir);
		if (repo) votes.set(repo, (votes.get(repo) ?? 0) + count);
	}
	return (
		[...votes].sort(
			(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
		)[0]?.[0] ?? null
	);
}

/** A transcript's scan, re-read only when the file changed. */
async function scanCached(path: string): Promise<TranscriptScan | null> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return null;
		const hit = cache.get(path);
		if (hit && hit.mtimeMs === info.mtimeMs && hit.bytes === info.size)
			return hit.scan;
		const scan = scanTranscript(await readFile(path, "utf-8"));
		cache.set(path, { mtimeMs: info.mtimeMs, bytes: info.size, scan });
		return scan;
	} catch {
		return null; // deleted mid-scan, or unreadable
	}
}

/** Time two sorted, non-overlapping interval lists share. */
export function overlapMs(a: Interval[], b: Interval[]): number {
	let shared = 0;
	let j = 0;
	for (const [start, end] of a) {
		while (j < b.length && (b[j] as Interval)[1] <= start) j++;
		for (let k = j; k < b.length && (b[k] as Interval)[0] < end; k++) {
			const [bStart, bEnd] = b[k] as Interval;
			shared += Math.max(0, Math.min(end, bEnd) - Math.max(start, bStart));
		}
	}
	return shared;
}

/**
 * The agent's own work in a session: its active time less the stretches it
 * sat waiting on you (a reply under five minutes doesn't break a span, so
 * your reading time was being billed as agent time), plus every subagent's.
 */
export function yourSpans(session: SessionWork): Interval[] {
	// Both, merged: the open-pane record only reaches back to when it landed,
	// and before that the prompt gaps are all there is. Where both exist the
	// pane covers the gaps (you type into an open pane), so nothing doubles.
	return mergeIntervals([...session.yours, ...session.attended]);
}

export function agentMs(session: SessionWork): number {
	return (
		session.activeMs -
		overlapMs(session.intervals, mergeIntervals(session.yours)) +
		totalMs(session.subagents)
	);
}

/** A session's scan as Odin keeps it, with nothing that's looked up live. */
type KeptSession = TranscriptScan & {
	sessionId: string;
	project: string;
	subagents: Interval[];
};

/**
 * Claude Code deletes a transcript after 30 days (`cleanupPeriodDays`), and
 * Insights' history went with it. Every scan is kept here instead, so a
 * session outlives its transcript.
 *
 * ponytail: one JSON file, ~1 MB a month of sessions, rewritten whole on any
 * change; move it into local.db if that ever gets slow.
 */
export function archivePath(): string {
	return join(ODIN_HOME_DIR, "session-scans.json");
}

/** Null when the file is there but unreadable: it's left alone, not overwritten. */
async function readArchive(
	path: string,
): Promise<Map<string, KeptSession> | null> {
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch {
		return new Map(); // nothing kept yet
	}
	try {
		return new Map(Object.entries(JSON.parse(text)));
	} catch (error) {
		console.warn(
			"[insights] session archive unreadable, not touching it:",
			error,
		);
		return null;
	}
}

async function writeArchive(
	path: string,
	kept: Map<string, KeptSession>,
): Promise<void> {
	try {
		// Through a temp file: a crash mid-write must not take the only copy of
		// sessions whose transcripts are already gone.
		await writeFile(`${path}.tmp`, JSON.stringify(Object.fromEntries(kept)));
		await rename(`${path}.tmp`, path);
	} catch (error) {
		console.warn("[insights] session archive not saved:", error);
	}
}

/**
 * Every session on this machine, scanned, each carrying its subagents' spans
 * (`<session>/subagents/*.jsonl`) rather than listing them as sessions - plus
 * every session kept in the archive whose transcript has since been deleted.
 */
export async function scanSessions({
	root = projectsRoot(),
	people = new Map<string, SessionPerson>(),
	attention = new Map<string, Interval[]>(),
	archive = archivePath(),
}: {
	root?: string;
	people?: Map<string, SessionPerson>;
	attention?: Map<string, Interval[]>;
	/** Where scans are kept; null keeps nothing. */
	archive?: string | null;
} = {}): Promise<SessionWork[]> {
	const kept = archive ? await readArchive(archive) : null;
	let changed = false;
	const live = (session: KeptSession): SessionWork => {
		const who = people.get(session.sessionId);
		return {
			...session,
			attended: attention.get(session.sessionId) ?? [],
			repo: repoForDirs(session.dirs),
			person: who?.person ?? null,
			source: who?.source ?? null,
		};
	};
	let projects: string[] = [];
	try {
		projects = (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		// no transcripts left on disk; the archive may still have some
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
			const scan = await scanCached(path);
			if (!scan) continue;
			const sessionId = name.slice(0, -".jsonl".length);
			// Subagents work alongside their parent, in transcripts of their own;
			// their time is agent work the parent's transcript never shows.
			const subagents: Interval[] = [];
			const subDir = join(root, project, sessionId, "subagents");
			let subNames: string[] = [];
			try {
				subNames = await readdir(subDir);
			} catch {
				// no subagents
			}
			for (const sub of subNames)
				if (sub.endsWith(".jsonl"))
					subagents.push(
						...((await scanCached(join(subDir, sub)))?.intervals ?? []),
					);
			const session = { ...scan, subagents, sessionId, project };
			const was = kept?.get(sessionId);
			if (
				kept &&
				(was?.entries !== scan.entries ||
					was.subagents.length !== subagents.length)
			) {
				kept.set(sessionId, session);
				changed = true;
			}
			sessions.push(live(session));
		}
	}
	const onDisk = new Set(sessions.map((session) => session.sessionId));
	for (const [sessionId, session] of kept ?? [])
		if (!onDisk.has(sessionId)) sessions.push(live(session));
	if (archive && kept && changed) await writeArchive(archive, kept);
	return sessions;
}

export interface WeekRow {
	/** Sunday 00:00 local, as an epoch ms. */
	start: number;
	agentHours: number;
	yourHours: number;
	sessions: number;
	/** Merged PRs opened this week. */
	shipped: number;
}

export interface TaskRow {
	sessionId: string;
	title: string;
	repo: string | null;
	person: string | null;
	source: string | null;
	hours: number;
	/** Your time in it, estimated - see `humanIntervals`. */
	yourHours: number;
	startedAt: number;
	endedAt: number;
	/** Separate bursts of activity the hours are summed from. */
	stretches: number;
	/** What the session was for, for a hover. */
	description: string | null;
	prs: string[];
}

export interface RecapWeek {
	/** Sunday 00:00 local. */
	start: number;
	sessions: number;
	agentHours: number;
	yourHours: number;
	prs: number;
	/** Every session that week, biggest first. */
	tasks: TaskRow[];
}

export interface Workload {
	sessions: number;
	agentHours: number;
	yourHours: number;
	/** Agent-hours per hour of yours. Null until there's an hour to divide by. */
	leverage: number | null;
	/** Oldest first, one row per week including the quiet ones. */
	weeks: WeekRow[];
	/** Every week with any session, oldest first - what got done in it. */
	recap: RecapWeek[];
	byRepo: { repo: string; hours: number; sessions: number }[];
	byPerson: { person: string; hours: number; sessions: number }[];
	/** Active minutes per hour of the day, local, index 0–23. */
	byHour: number[];
	/**
	 * The same minutes, kept per week instead of folded together: one row per
	 * week that has any, oldest first, each holding 168 cells indexed
	 * `weekday * 24 + hour` with Sunday as weekday 0.
	 */
	heatmap: { start: number; minutes: number[] }[];
	/** The same grid over the agents' clock time - any agent running counts. */
	agentHeatmap: { start: number; minutes: number[] }[];
	busiestDay: { at: number; hours: number } | null;
	/** Sessions with a name attached - the rest are your own. */
	attributed: number;
	/** When the record starts, so a thin first week reads as thin, not idle. */
	since: number | null;
	/** Every repo with any session, busiest first - before any filter. */
	repos: string[];
}

function hours(ms: number): number {
	return Math.round((ms / HOUR_MS) * 10) / 10;
}

function taskRow(session: SessionWork): TaskRow {
	return {
		sessionId: session.sessionId,
		title: session.title ?? `session ${session.sessionId.slice(0, 8)}`,
		repo: session.repo,
		person: session.person,
		source: session.source,
		hours: hours(agentMs(session)),
		yourHours: hours(totalMs(yourSpans(session))),
		startedAt: session.startedAt,
		endedAt: session.endedAt,
		stretches: session.intervals.length,
		description: session.opening,
		prs: session.prs,
	};
}

/**
 * Sunday 00:00 local time for the week containing `at` - the work week here
 * runs Sunday to Thursday, so a Monday start split every week in two.
 */
export function weekStart(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() - date.getDay());
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
		row.ms += agentMs(session);
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

/**
 * A session cut into one piece per week it was active in, each carrying only
 * that week's bursts and the PRs it opened then. A session left running across
 * the weekend is work in both weeks - filing all of it under the week it
 * started put a live task's hours in a week you'd stopped looking at.
 *
 * ponytail: a single burst straddling Saturday midnight counts in the week it
 * began; split the interval if that ever matters.
 */
export function byWeek(session: SessionWork): SessionWork[] {
	const weeks = new Map<
		number,
		{
			intervals: Interval[];
			yours: Interval[];
			attended: Interval[];
			subagents: Interval[];
			prs: string[];
			prAt: (number | null)[];
		}
	>();
	const slot = (start: number) => {
		let piece = weeks.get(start);
		if (!piece) {
			piece = {
				intervals: [],
				yours: [],
				attended: [],
				subagents: [],
				prs: [],
				prAt: [],
			};
			weeks.set(start, piece);
		}
		return piece;
	};
	for (const interval of session.intervals)
		slot(weekStart(interval[0])).intervals.push(interval);
	for (const interval of session.yours)
		slot(weekStart(interval[0])).yours.push(interval);
	for (const interval of session.attended)
		slot(weekStart(interval[0])).attended.push(interval);
	for (const interval of session.subagents)
		slot(weekStart(interval[0])).subagents.push(interval);
	session.prs.forEach((url, index) => {
		const at = session.prAt[index] ?? null;
		const piece = slot(weekStart(at ?? session.startedAt));
		piece.prs.push(url);
		piece.prAt.push(at);
	});
	if (weeks.size <= 1) return [session];
	return [...weeks].map(([start, piece]) => ({
		...session,
		...piece,
		activeMs: totalMs(piece.intervals),
		startedAt: piece.intervals[0]?.[0] ?? start,
		endedAt: piece.intervals.at(-1)?.[1] ?? start,
	}));
}

/** Sessions grouped by the week they started, each week's biggest first. */
function recap(sessions: SessionWork[]): RecapWeek[] {
	const weeks = new Map<number, SessionWork[]>();
	for (const session of sessions) {
		const start = weekStart(session.startedAt);
		weeks.set(start, [...(weeks.get(start) ?? []), session]);
	}
	return [...weeks]
		.sort((a, b) => a[0] - b[0])
		.map(([start, list]) => ({
			start,
			sessions: list.length,
			agentHours: hours(list.reduce((sum, s) => sum + agentMs(s), 0)),
			yourHours: hours(totalMs(mergeIntervals(list.flatMap(yourSpans)))),
			prs: list.reduce((sum, s) => sum + s.prs.length, 0),
			// Every session, uncapped: the page filters by repo and shows a top few
			// until you ask for the rest.
			tasks: [...list].sort((a, b) => agentMs(b) - agentMs(a)).map(taskRow),
		}));
}

const BLIP_MS = 60_000;

/**
 * Minutes per hour of the day, folded across all weeks (`byHour`) and kept per
 * week (`heatmap`, cells indexed by working day, so a row's 00–05 are the
 * night after it). Only weeks with a minute in them get a row - an empty grid
 * is cheaper to draw than to ship.
 */
function hourCells(intervals: Interval[]): {
	byHour: number[];
	heatmap: { start: number; minutes: number[] }[];
} {
	const byHour: number[] = Array.from({ length: 24 }, () => 0);
	const weekCells = new Map<number, number[]>();
	for (const [start, end] of intervals) {
		let at = start;
		while (at < end) {
			const date = new Date(at);
			date.setMinutes(0, 0, 0);
			const next = Math.min(end, date.getTime() + HOUR_MS);
			const minutes = Math.round((next - at) / 60_000);
			byHour[date.getHours()] += minutes;
			// A working day runs 06:00 to 05:59, so 02:00 Sunday is Saturday
			// night's - in last week's row, not this week's.
			const workday = new Date(at - 6 * HOUR_MS);
			const week = weekStart(workday.getTime());
			let cells = weekCells.get(week);
			if (!cells) {
				cells = Array.from({ length: 7 * 24 }, () => 0);
				weekCells.set(week, cells);
			}
			cells[workday.getDay() * 24 + date.getHours()] += minutes;
			at = next;
		}
	}
	return {
		byHour,
		heatmap: [...weekCells]
			.sort((a, b) => a[0] - b[0])
			.map(([start, minutes]) => ({ start, minutes })),
	};
}

export function computeWorkload(
	sessions: SessionWork[],
	{
		now = Date.now(),
		weeks = 12,
		top = 8,
		only = null,
		hide = [],
	}: {
		now?: number;
		weeks?: number;
		top?: number;
		/** Count only this repo's sessions. */
		only?: string | null;
		/** Leave these repos' sessions out of every number. */
		hide?: string[];
	} = {},
): Workload {
	const repoOf = (session: SessionWork) => session.repo;
	// Under a minute with nothing shipped is a machine blip, not work: Odin's
	// own `claude -p` calls (card briefs, the Next in line ranking) and one-line
	// probes. Counted, they buried a week's real work under rows of "0".
	const worked = sessions.filter(
		(session) => session.activeMs >= BLIP_MS || session.prs.length > 0,
	);
	const all = worked.filter((session) => {
		const repo = repoOf(session);
		return (!only || repo === only) && !(repo && hide.includes(repo));
	});
	const everything = all.flatMap((session) => session.intervals);
	const merged = mergeIntervals(everything);

	// A week's worth of rows, present or not - a gap in the history is itself
	// the answer to "how was last week", and a bar chart that silently drops
	// empty weeks makes a quiet fortnight look busy.
	const firstWeek = weekStart(now) - (weeks - 1) * 7 * DAY_MS;
	const buckets = new Map<
		number,
		{ agentMs: number; yours: Interval[]; sessions: number; shipped: number }
	>();
	for (let index = 0; index < weeks; index++) {
		// Rebuilt from a date each step so DST can't drift the boundary.
		const start = weekStart(firstWeek + index * 7 * DAY_MS + DAY_MS / 2);
		buckets.set(start, { agentMs: 0, yours: [], sessions: 0, shipped: 0 });
	}
	const pieces = all.flatMap(byWeek);
	for (const session of pieces) {
		const bucket = buckets.get(weekStart(session.startedAt));
		if (!bucket) continue;
		bucket.agentMs += agentMs(session);
		bucket.sessions += 1;
		bucket.yours.push(...yourSpans(session));
	}
	// Every merged PR ships in the week it opened. The caller drops unmerged
	// ones, so a fix redone after a closed PR still counts once.
	for (const session of all)
		for (const at of session.prAt) {
			const bucket = buckets.get(weekStart(at ?? session.startedAt));
			if (bucket) bucket.shipped += 1;
		}

	const days = byDay(merged);
	const busiest = [...days].sort((a, b) => b[1] - a[1])[0];

	// Your time, not the agent's: a scheduled run at 09:00 painted an hour
	// nobody worked. The agents' clock time is banked separately so the page can
	// show the off-hours they ran through - `merged`, so three agents at 2am is
	// one 2am.
	const yours = mergeIntervals(all.flatMap(yourSpans));
	const { byHour, heatmap } = hourCells(yours);
	const agentHeatmap = hourCells(merged).heatmap;

	// Your time, not "any agent running": that was parallelism, and dividing
	// by it made leverage read as how many agents ran at once.
	const yourMs = totalMs(yours);
	const agentTotal = all.reduce((sum, session) => sum + agentMs(session), 0);

	const since = all.length
		? Math.min(...all.map((session) => session.startedAt))
		: null;
	// Weeks before the transcript store begins aren't quiet weeks, they're weeks
	// with no record - and a row of empty columns claiming otherwise was the
	// chart's least honest part. Drop them; the note says where the record starts.
	const firstRecorded = since === null ? null : weekStart(since);

	return {
		// Off the unfiltered set, so a filter never hides its own way back.
		repos: tallyHours(worked, repoOf, Number.POSITIVE_INFINITY).map(
			(row) => row.name,
		),
		sessions: all.length,
		agentHours: hours(agentTotal),
		yourHours: hours(yourMs),
		leverage: yourMs > 0 ? Math.round((agentTotal / yourMs) * 10) / 10 : null,
		weeks: [...buckets]
			.sort((a, b) => a[0] - b[0])
			.filter(([start]) => firstRecorded === null || start >= firstRecorded)
			.map(([start, bucket]) => ({
				start,
				agentHours: hours(bucket.agentMs),
				yourHours: hours(totalMs(mergeIntervals(bucket.yours))),
				sessions: bucket.sessions,
				shipped: bucket.shipped,
			})),
		recap: recap(pieces),
		byRepo: tallyHours(all, (session) => session.repo, top).map(
			({ name, hours: h, sessions: count }) => ({
				repo: name,
				hours: h,
				sessions: count,
			}),
		),
		byPerson: tallyHours(all, (session) => session.person, top).map(
			({ name, hours: h, sessions: count }) => ({
				person: name,
				hours: h,
				sessions: count,
			}),
		),
		byHour,
		heatmap,
		agentHeatmap,
		busiestDay: busiest ? { at: busiest[0], hours: hours(busiest[1]) } : null,
		attributed: all.filter((session) => session.person).length,
		since,
	};
}
