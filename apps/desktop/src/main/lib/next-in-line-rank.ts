import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execWithShellEnv } from "lib/trpc/routers/workspaces/utils/shell-env";
import { transcriptOf } from "./claude-sessions/claude-sessions";
import { briefError } from "./claude-sessions/summarize";

/**
 * The board's Next in line column, ordered by a model: which unstarted task
 * matters most. Priority fields alone can't say that — Jira's "High" and a
 * Slack ask from your manager aren't on one scale, and a GDPR request has a
 * legal clock no field records. Same `claude -p` path as the session briefs.
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
}

/**
 * How many the model orders. Output is what costs time — all ~260 keys took
 * 85s, and nobody reads task #200 by importance. The rest keep the rule order.
 */
const TOP = 50;

const INSTRUCTIONS = `You rank an engineering manager's unstarted tasks by importance: what should be started first.
Weigh, roughly in this order: hard deadlines (due/overdue dates, legal or compliance clocks like GDPR deletion requests), customer-facing breakage and production bugs, people blocked waiting on them (review requests, direct asks), stated priority, then age.
Each line is: key | source | priority | due | age in days | person | where | title.
Answer with ONLY a JSON array of the ${TOP} most important keys (or all of them, if fewer), most important first. No prose.`;

/** Known keys in the model's order, once each; invented ones dropped. */
export function parseRanking(text: string, keys: string[]): string[] {
	const known = new Set(keys);
	let ranked: unknown = [];
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start !== -1 && end > start) {
		try {
			ranked = JSON.parse(text.slice(start, end + 1));
		} catch {}
	}
	const seen = new Set<string>();
	for (const key of Array.isArray(ranked) ? ranked : [])
		if (typeof key === "string" && known.has(key)) seen.add(key);
	return [...seen];
}

function line(item: RankItem): string {
	return [
		item.key,
		item.source,
		item.priority ?? "-",
		item.due ?? "-",
		item.ageDays ?? "-",
		item.person ?? "-",
		item.context ?? "-",
		item.title.replace(/\s+/g, " ").slice(0, 160),
	].join(" | ");
}

// ponytail: in-memory, one entry per exact input. Feeds refetch with the same
// rows most of the time, so that's the hit that matters; persist it if a
// restart's re-rank ever costs enough to notice.
const cache = new Map<string, string[]>();
const inFlight = new Map<string, Promise<string[]>>();

export async function rankTasks(
	items: RankItem[],
	{ claudeBin = "claude", timeoutMs = 180_000 } = {},
): Promise<string[]> {
	const keys = items.map((item) => item.key);
	if (items.length < 2) return [];
	const body = items.map(line).join("\n");
	const hit = cache.get(body);
	if (hit) return hit;
	const running = inFlight.get(body);
	if (running) return running;

	const work = (async () => {
		// Named so its transcript can be deleted — see writeBrief.
		const sessionId = randomUUID();
		try {
			const { stdout } = await execWithShellEnv(
				claudeBin,
				[
					"-p",
					`${INSTRUCTIONS}\n\n--- TASKS ---\n${body}`,
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
