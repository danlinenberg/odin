import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { transcriptOf } from "./claude-sessions/claude-sessions";
import {
	briefError,
	cachedBriefs,
	claudePrint,
} from "./claude-sessions/summarize";

/**
 * The Today overview's words: the open sessions grouped into tasks, each
 * with what it is and where it stands, and one line over all of it. Written from the session briefs the board already keeps,
 * on the same cheap `claude -p` path - no transcript is read again here.
 */

export interface TodayItem {
	key: string;
	/** The session's Claude conversation id, to look its brief up. */
	sessionId: string | null;
	title: string;
	/** Where it stands, in the overview's words: "Needs you", "Running"... */
	group: string;
	due: string | null;
	priority: string | null;
	/** Who or what it waits on, when it waits on someone else. */
	waitingOn: string | null;
}

/** One task: the sessions that serve it, in plain words. */
export interface TodayTask {
	/** The sessions' keys, in the order the model named them. */
	keys: string[];
	/** A short name for the task. */
	name: string;
	/** What the task is and why it matters, for someone who never saw it. */
	about: string | null;
	/** Where it stands and how much is left. */
	line: string | null;
}

export interface TodayLines {
	/** One sentence over the whole list. Null when the model gave none. */
	summary: string | null;
	/** The sessions grouped into tasks. A session the model skipped is in none. */
	tasks: TodayTask[];
}

const INSTRUCTIONS = `You write a short morning overview of someone's open work, in plain language, for a busy person reading it over coffee.
Each numbered line below is one work session: number | where it stands | due | priority | waiting on | title | goal | status | next step.
Several sessions often serve the same task (the same feature, bug, request or investigation): put those in one task.
Reply with ONLY these lines, no markdown, no preamble:
SUMMARY: <one short sentence over all of it: what needs them first and any deadline>
TASK <session numbers, comma separated>: <task name, 2 to 6 words> | <what the task is and why it matters, for someone who never saw it> | <where it stands and how much is left, e.g. "done, only waits for testing", "running, about half left", "waiting for someone to reply">
Every session number goes in exactly one TASK line. A session that shares nothing with the others is a task of its own.

Rules:
- Always answer in English.
- No PR numbers, ticket keys, issue numbers, commit hashes, branch names, file paths or URLs. Say "the pull request" or "the ticket" instead.
- Say what the work is about in everyday words, not code names.
- Under 140 characters for the summary and for each part of a TASK line.`;

const clean = (text: string | null | undefined, cap: number) =>
	(text ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, cap) ||
	"-";

/** One task as the model reads it. */
export function todayLine(
	item: TodayItem,
	index: number,
	brief?: {
		goal?: string | null;
		status?: string | null;
		next?: string | null;
	},
): string {
	return [
		index + 1,
		item.group,
		item.due ?? "-",
		item.priority ?? "-",
		clean(item.waitingOn, 80),
		clean(item.title, 120),
		clean(brief?.goal, 240),
		clean(brief?.status, 200),
		clean(brief?.next, 200),
	].join(" | ");
}

/** The model's answer back into a summary and the tasks. */
export function parseTodayLines(text: string, keys: string[]): TodayLines {
	const tasks: TodayTask[] = [];
	const used = new Set<string>();
	let summary: string | null = null;
	for (const raw of text.split("\n")) {
		const row = raw
			.replace(/^[\s*-]+/, "")
			.replace(/\*\*/g, "")
			.trim();
		const said = /^summary\s*:\s*(.+)$/i.exec(row);
		if (said) {
			summary = said[1].trim() || null;
			continue;
		}
		const task = /^task\s+([\d,\s]+?)\s*[:.)]\s*(.+)$/i.exec(row);
		if (!task) continue;
		const mine = task[1]
			.split(/[,\s]+/)
			.map((n) => keys[Number(n) - 1])
			.filter((key): key is string => !!key && !used.has(key));
		const [name, about, line] = task[2].split("|").map((part) => part.trim());
		if (!mine.length || !name) continue;
		for (const key of mine) used.add(key);
		tasks.push({
			keys: [...new Set(mine)],
			name,
			about: about || null,
			line: line || null,
		});
	}
	return { summary, tasks };
}

const cache = new Map<string, TodayLines>();
const inFlight = new Map<string, Promise<TodayLines>>();

export async function writeTodayLines(
	items: TodayItem[],
	{
		claudeBin = "claude",
		timeoutMs = 120_000,
		fresh = false,
	}: { claudeBin?: string; timeoutMs?: number; fresh?: boolean } = {},
): Promise<TodayLines> {
	if (!items.length) return { summary: null, tasks: [] };
	const briefs = await cachedBriefs().catch(() => new Map());
	const body = items
		.map((item, i) =>
			todayLine(
				item,
				i,
				item.sessionId ? briefs.get(item.sessionId) : undefined,
			),
		)
		.join("\n");
	// Same body, same answer: opening the overview again costs nothing.
	// Refresh asks for a new answer even when the work is unchanged.
	const hit = fresh ? undefined : cache.get(body);
	if (hit) return hit;
	const running = inFlight.get(body);
	if (running) return running;

	const keys = items.map((item) => item.key);
	const work = (async () => {
		// Named so its transcript can be deleted - see writeBrief.
		const sessionId = randomUUID();
		try {
			const { stdout } = await claudePrint(
				claudeBin,
				[
					"-p",
					`${INSTRUCTIONS}\n\n--- WORK ---\n${body}`,
					"--model",
					"haiku",
					"--session-id",
					sessionId,
					"--strict-mcp-config",
					"--mcp-config",
					'{"mcpServers":{}}',
				],
				{ cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 1_000_000 },
			);
			const written = parseTodayLines(stdout, keys);
			if (cache.size >= 20) cache.clear();
			cache.set(body, written);
			return written;
		} catch (error) {
			throw briefError(error, "writing the Today overview");
		} finally {
			const litter = await transcriptOf(sessionId);
			if (litter) await rm(litter.path, { force: true });
		}
	})();
	inFlight.set(body, work);
	try {
		return await work;
	} finally {
		inFlight.delete(body);
	}
}
