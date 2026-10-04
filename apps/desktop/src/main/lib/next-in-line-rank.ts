import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execWithShellEnv } from "lib/trpc/routers/workspaces/utils/shell-env";
import { transcriptOf } from "./claude-sessions/claude-sessions";
import { briefError } from "./claude-sessions/summarize";

/**
 * The board's Next in line column, ordered by a model: which unstarted task
 * matters most. The app has no opinion of its own - no priority rules, no
 * fallback order. Same `claude -p` path as the session briefs.
 */

export interface RankItem {
	key: string;
	title: string;
	source: string;
	priority: string | null;
	person: string | null;
	context: string | null;
	due: string | null;
	/** Days since the source dated it; null when it didn't. */
	ageDays: number | null;
	/** The Review sweep's last verdict on it (DROP / KEEP / UNKNOWN), if swept. */
	review: string | null;
}

export interface Ranking {
	/** Most important first. */
	keys: string[];
	/** What your instructions say not to show at all. */
	hidden: string[];
}

// Deliberately no criteria: what counts as important is the model's call, not
// a weighting written into the app.
const INSTRUCTIONS = `Rank these unstarted tasks by importance: which should be started first.
The lines are in the "All tasks" view's order: newest activity first.
Each line is: number | source | priority | due | age in days | person | where | review | title.
"review" is the Review panel's last sweep verdict: DROP means the sweep found it already done or gone.
Answer with ONLY a JSON object, no prose: {"order": [every line number to show, most important first], "hide": [line numbers my instructions say not to show]}.`;

/**
 * The model answers in line numbers, not keys - a 200-task answer is then
 * ~1KB instead of ~4KB, and output is where the minute goes (measured: 22-45s
 * vs 70-104s for 205 tasks). Known lines in its order, once each.
 */
export function parseRanking(text: string, keys: string[]): Ranking {
	let answer: unknown = null;
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			answer = JSON.parse(text.slice(start, end + 1));
		} catch {}
	}
	const pick = (list: unknown, skip: Set<string>) => {
		const seen = new Set<string>();
		for (const n of Array.isArray(list) ? list : []) {
			const key = Number.isInteger(n) ? keys[n - 1] : undefined;
			if (key !== undefined && !skip.has(key)) seen.add(key);
		}
		return seen;
	};
	const { order, hide } = (answer ?? {}) as { order?: unknown; hide?: unknown };
	const hidden = pick(hide, new Set());
	return { keys: [...pick(order, hidden)], hidden: [...hidden] };
}

function line(item: RankItem, index: number): string {
	return [
		index + 1,
		item.source,
		item.priority ?? "-",
		item.due ?? "-",
		item.ageDays ?? "-",
		item.person ?? "-",
		item.context ?? "-",
		item.review ?? "-",
		item.title.replace(/\s+/g, " ").slice(0, 160),
	].join(" | ");
}

// ponytail: in-memory, one entry per exact input. Feeds refetch with the same
// rows most of the time, so that's the hit that matters; persist it if a
// restart's re-rank ever costs enough to notice.
const cache = new Map<string, Ranking>();
const inFlight = new Map<string, Promise<Ranking>>();

export async function rankTasks(
	items: RankItem[],
	{
		instructions = "",
		claudeBin = "claude",
		timeoutMs = 180_000,
		fresh = false,
	}: {
		instructions?: string;
		claudeBin?: string;
		timeoutMs?: number;
		fresh?: boolean;
	} = {},
): Promise<Ranking> {
	const keys = items.map((item) => item.key);
	if (items.length < 2) return { keys: [], hidden: [] };
	// Your own words from Settings → Backlog, when you've written any. Part of
	// the cache key, so editing them re-ranks.
	const how = instructions.trim()
		? `\n\nHow I want them sorted, in my words:\n${instructions.trim()}`
		: "";
	const body = `${how}\n\n--- TASKS ---\n${items.map(line).join("\n")}`;
	const hit = fresh ? undefined : cache.get(body);
	if (hit) return hit;
	const running = inFlight.get(body);
	if (running) return running;

	const work = (async () => {
		// Named so its transcript can be deleted - see writeBrief.
		const sessionId = randomUUID();
		try {
			const { stdout } = await execWithShellEnv(
				claudeBin,
				[
					"-p",
					`${INSTRUCTIONS}${body}`,
					"--model",
					"haiku",
					"--session-id",
					sessionId,
					"--strict-mcp-config",
					"--mcp-config",
					'{"mcpServers":{}}',
				],
				{ cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 2_000_000 },
			);
			const ranked = parseRanking(stdout, keys);
			if (cache.size >= 20) cache.clear();
			cache.set(body, ranked);
			return ranked;
		} catch (error) {
			throw briefError(error);
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
