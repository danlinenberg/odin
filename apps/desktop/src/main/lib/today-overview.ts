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
 * The Today overview's words: one plain line per piece of work, and one line
 * over all of it. Written from the session briefs the board already keeps,
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

export interface TodayLines {
	/** One or two sentences over the whole list. Null when the model gave none. */
	summary: string | null;
	/** key -> its one plain line. Missing when the model skipped it. */
	lines: Record<string, string>;
}

const INSTRUCTIONS = `You write a short morning overview of someone's open work, in plain language, for a busy person reading it over coffee.
Each numbered piece of work below is: number | where it stands | due | priority | waiting on | title | goal | status | next step.
Reply with ONLY these lines, no markdown, no preamble:
SUMMARY: <one or two short sentences over all of it: how much is open, what needs them first, any deadline>
<number>: <one plain sentence for that piece of work: what it is, where it stands and roughly how much is left>
Write one numbered line for every piece of work.

Rules:
- Always answer in English.
- No PR numbers, ticket keys, issue numbers, commit hashes, branch names, file paths or URLs. Say "the pull request" or "the ticket" instead.
- Say what the work is about in everyday words, not code names.
- Under 140 characters per numbered line.`;

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

/** The model's answer back into a summary and a line per key. */
export function parseTodayLines(text: string, keys: string[]): TodayLines {
	const lines: Record<string, string> = {};
	let summary: string | null = null;
	for (const raw of text.split("\n")) {
		const row = raw.replace(/^[\s*-]+/, "").trim();
		const said = /^summary\**\s*:\s*(.+)$/i.exec(row);
		if (said) {
			summary = said[1].trim() || null;
			continue;
		}
		const numbered = /^(\d+)\s*[:.)]\s*(.+)$/.exec(row);
		if (!numbered) continue;
		const key = keys[Number(numbered[1]) - 1];
		if (key && !(key in lines)) lines[key] = numbered[2].trim();
	}
	return { summary, lines };
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
	if (!items.length) return { summary: null, lines: {} };
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
