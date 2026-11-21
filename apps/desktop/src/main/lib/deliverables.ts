import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { transcriptOf } from "./claude-sessions/claude-sessions";
import { briefError, claudePrint } from "./claude-sessions/summarize";

/**
 * Insights → Delivered per week: what counts as shipped when your work isn't
 * pull requests. You name your own kinds of deliverable ("Email campaign
 * live", "Asset placed in the app") with a plain description; Odin reads each
 * finished session's brief - its title and what it did, already written for
 * the board - and asks a small model which kinds it delivered. One verdict
 * per session, cached until the brief or your kinds change, so a week of work
 * costs a handful of cheap calls once and nothing after.
 */

export interface DeliverableKind {
	id: string;
	/** What the chart calls it: "Emails sent live". */
	name: string;
	/** What finished looks like, in your words - what the model judges by. */
	description: string;
}

export interface SessionForVerdict {
	sessionId: string;
	title: string;
	/** The brief's goal and status, or the session's opening. */
	description: string | null;
	endedAt: number;
}

interface Verdict {
	/** Which brief and which set of kinds it was judged on. */
	key: string;
	kinds: string[];
	at: number;
}

interface Store {
	kinds: DeliverableKind[];
	verdicts: Record<string, Verdict>;
}

/** A session still moving can still deliver; judge it once it's gone quiet. */
export const SETTLED_AFTER_MS = 30 * 60_000;
/** Older sessions than this aren't judged: the chart reads recent weeks. */
export const LOOKBACK_MS = 12 * 7 * 24 * 3_600_000;
/** Sessions per model call - one short line each. */
const BATCH = 20;
/** Calls per background run; the next refresh carries on from there. */
const MAX_BATCHES = 6;
const MAX_KINDS = 8;
const VERDICTS_MAX = 3_000;

export function defaultStorePath(): string {
	return join(homedir(), ".odin", "deliverables.json");
}

const memo: { path: string | null; store: Store } = {
	path: null,
	store: { kinds: [], verdicts: {} },
};

async function load(path: string): Promise<Store> {
	if (memo.path === path) return memo.store;
	memo.path = path;
	memo.store = { kinds: [], verdicts: {} };
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<Store>;
		memo.store = {
			kinds: Array.isArray(parsed.kinds) ? parsed.kinds : [],
			verdicts: parsed.verdicts ?? {},
		};
	} catch {
		// none yet
	}
	return memo.store;
}

async function save(path: string): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(memo.store));
	} catch {
		// a verdict we can't keep is asked for again next time
	}
}

export async function readKinds(
	path = defaultStorePath(),
): Promise<DeliverableKind[]> {
	return (await load(path)).kinds;
}

/** Saves your kinds: trimmed, unnamed ones dropped, at most eight. */
export async function writeKinds(
	kinds: { id?: string; name: string; description: string }[],
	path = defaultStorePath(),
): Promise<DeliverableKind[]> {
	const store = await load(path);
	store.kinds = kinds
		.map((kind) => ({
			id: kind.id || randomUUID().slice(0, 8),
			name: kind.name.trim().slice(0, 60),
			description: kind.description.trim().slice(0, 400),
		}))
		.filter((kind) => kind.name)
		.slice(0, MAX_KINDS);
	await save(path);
	return store.kinds;
}

const hash = (text: string) =>
	createHash("sha1").update(text).digest("hex").slice(0, 12);

/** Changes when the brief or any kind's name or description does. */
export function verdictKey(
	session: SessionForVerdict,
	kinds: DeliverableKind[],
): string {
	return hash(
		JSON.stringify([
			kinds.map((k) => [k.id, k.name, k.description]),
			session.title,
			session.description,
		]),
	);
}

const oneLine = (text: string | null, cap: number) =>
	(text ?? "").replace(/\s+/g, " ").trim().slice(0, cap);

export function classifyPrompt(
	sessions: SessionForVerdict[],
	kinds: DeliverableKind[],
): string {
	return `You sort finished work sessions by what they delivered. The person defined these kinds of deliverable:
${kinds.map((k) => `- ${k.id}: ${k.name} - ${oneLine(k.description, 300)}`).join("\n")}

For each session below, name the kinds it actually DELIVERED: the thing was finished and handed over, sent, published or put live - not only planned, drafted, discussed or investigated. Most sessions deliver none. A session can deliver more than one kind.

Reply with one line per session and nothing else, exactly:
S<number>: <comma-separated kind ids, or none>

${sessions
	.map(
		(s, i) =>
			`S${i + 1}: ${oneLine(s.title, 120)}${s.description ? ` | ${oneLine(s.description, 500)}` : ""}`,
	)
	.join("\n")}`;
}

/** Kind ids per session, in order; a line missing or garbled reads as none. */
export function parseClassification(
	text: string,
	count: number,
	kinds: DeliverableKind[],
): string[][] {
	const known = new Set(kinds.map((k) => k.id));
	const out: string[][] = Array.from({ length: count }, () => []);
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*\**S(\d+)\**\s*:\s*(.*)$/i);
		if (!match) continue;
		const index = Number(match[1]) - 1;
		if (index < 0 || index >= count) continue;
		out[index] = [
			...new Set(
				(match[2] ?? "")
					.split(/[,\s]+/)
					.map((id) => id.trim())
					.filter((id) => known.has(id)),
			),
		];
	}
	return out;
}

export type ModelCall = (prompt: string) => Promise<string>;

/** `claude -p` on Haiku, with no MCP servers, its own transcript deleted after. */
export const haiku: ModelCall = async (prompt) => {
	const sessionId = randomUUID();
	try {
		const { stdout } = await claudePrint(
			"claude",
			[
				"-p",
				prompt,
				"--model",
				"haiku",
				"--session-id",
				sessionId,
				"--strict-mcp-config",
				"--mcp-config",
				'{"mcpServers":{}}',
			],
			{ cwd: tmpdir(), timeout: 90_000, maxBuffer: 1_000_000 },
		);
		return stdout;
	} catch (error) {
		throw briefError(error, "sorting deliverables");
	} finally {
		const litter = await transcriptOf(sessionId);
		if (litter) await rm(litter.path, { force: true });
	}
};

/** The sessions that still need a verdict: settled, recent, not judged on this brief. */
export function pending(
	sessions: SessionForVerdict[],
	kinds: DeliverableKind[],
	verdicts: Record<string, Verdict>,
	now: number,
): SessionForVerdict[] {
	return sessions
		.filter(
			(s) =>
				s.endedAt < now - SETTLED_AFTER_MS &&
				s.endedAt > now - LOOKBACK_MS &&
				verdicts[s.sessionId]?.key !== verdictKey(s, kinds),
		)
		.sort((a, b) => b.endedAt - a.endedAt);
}

let running: Promise<void> | null = null;

/**
 * Judges what's pending in the background, newest first, a few batches per
 * run. Only one run at a time; Insights' next refresh shows what it found.
 */
export function judgeInBackground(
	sessions: SessionForVerdict[],
	{
		path = defaultStorePath(),
		model = haiku,
		now = Date.now(),
	}: { path?: string; model?: ModelCall; now?: number } = {},
): Promise<void> {
	if (running) return running;
	running = (async () => {
		const store = await load(path);
		const kinds = store.kinds;
		if (!kinds.length) return;
		const todo = pending(sessions, kinds, store.verdicts, now).slice(
			0,
			BATCH * MAX_BATCHES,
		);
		for (let i = 0; i < todo.length; i += BATCH) {
			const batch = todo.slice(i, i + BATCH);
			let reply: string;
			try {
				reply = await model(classifyPrompt(batch, kinds));
			} catch (error) {
				console.warn("[deliverables]", error);
				break;
			}
			const found = parseClassification(reply, batch.length, kinds);
			batch.forEach((session, index) => {
				store.verdicts[session.sessionId] = {
					key: verdictKey(session, kinds),
					kinds: found[index] ?? [],
					at: now,
				};
			});
			trim(store);
			await save(path);
		}
	})().finally(() => {
		running = null;
	});
	return running;
}

function trim(store: Store) {
	const ids = Object.keys(store.verdicts);
	if (ids.length <= VERDICTS_MAX) return;
	ids
		.sort((a, b) => (store.verdicts[a]?.at ?? 0) - (store.verdicts[b]?.at ?? 0))
		.slice(0, ids.length - VERDICTS_MAX)
		.forEach((id) => {
			delete store.verdicts[id];
		});
}

export interface DeliveredWeek {
	start: number;
	/** Sessions that delivered each kind this week, by kind id. */
	counts: Record<string, number>;
}

/**
 * Per week (the same Sunday starts Insights draws), how many finished
 * sessions delivered each kind - by the week each one ended. Only verdicts
 * judged on the current brief and kinds count; `judging` is how many are
 * still waiting for one.
 */
export function tallyDelivered(
	weekStarts: number[],
	sessions: SessionForVerdict[],
	kinds: DeliverableKind[],
	verdicts: Record<string, Verdict>,
	now: number,
): { weeks: DeliveredWeek[]; judging: number } {
	const weeks = weekStarts.map((start) => ({
		start,
		counts: Object.fromEntries(kinds.map((k) => [k.id, 0])),
	}));
	for (const session of sessions) {
		const verdict = verdicts[session.sessionId];
		if (!verdict || verdict.key !== verdictKey(session, kinds)) continue;
		const week = weeks.findLast((w) => w.start <= session.endedAt);
		if (!week) continue;
		for (const id of verdict.kinds)
			if (id in week.counts) week.counts[id] = (week.counts[id] ?? 0) + 1;
	}
	return { weeks, judging: pending(sessions, kinds, verdicts, now).length };
}

/** What Insights shows, and the background judging it sets off. */
export async function deliveredPerWeek(
	weekStarts: number[],
	sessions: SessionForVerdict[],
	options: { path?: string; model?: ModelCall; now?: number } = {},
): Promise<{
	kinds: DeliverableKind[];
	weeks: DeliveredWeek[];
	judging: number;
}> {
	const path = options.path ?? defaultStorePath();
	const now = options.now ?? Date.now();
	const store = await load(path);
	if (!store.kinds.length) return { kinds: [], weeks: [], judging: 0 };
	const tally = tallyDelivered(
		weekStarts,
		sessions,
		store.kinds,
		store.verdicts,
		now,
	);
	if (tally.judging > 0)
		void judgeInBackground(sessions, { ...options, path, now });
	return { kinds: store.kinds, ...tally };
}

export function suggestPrompt(sessions: SessionForVerdict[]): string {
	return `Here are recent work sessions someone ran with an AI agent. Suggest 2 to 5 kinds of deliverable that best describe what this person hands over or puts live in their job - the outcomes worth counting each week. They are not pull requests unless the work is code. Examples of the shape: "Emails sent live" (a campaign or email set live in the email tool), "Assets placed" (a marketing image or video put in the product), "Site changes handed off" (a website change sent to whoever publishes it).

Reply with one line per kind and nothing else, exactly:
<name, under 40 characters> | <one sentence: what counts as finished>

${sessions
	.slice(0, 60)
	.map(
		(s) =>
			`- ${oneLine(s.title, 100)}${s.description ? ` | ${oneLine(s.description, 240)}` : ""}`,
	)
	.join("\n")}`;
}

export function parseSuggestions(
	text: string,
): { name: string; description: string }[] {
	return text
		.split("\n")
		.map((line) => line.replace(/^\s*[-*\d.)]+\s*/, ""))
		.map((line) => {
			const [name, ...rest] = line.split("|");
			return {
				name: (name ?? "")
					.replace(/^["*]+|["*]+$/g, "")
					.trim()
					.slice(0, 60),
				description: rest.join("|").trim().slice(0, 400),
			};
		})
		.filter((kind) => kind.name && kind.description)
		.slice(0, 5);
}

/** One model call over your recent sessions' briefs: kinds you might add. */
export async function suggestKinds(
	sessions: SessionForVerdict[],
	model: ModelCall = haiku,
): Promise<{ name: string; description: string }[]> {
	if (!sessions.length) return [];
	const recent = [...sessions].sort((a, b) => b.endedAt - a.endedAt);
	return parseSuggestions(await model(suggestPrompt(recent)));
}
