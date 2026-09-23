import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execWithShellEnv } from "lib/trpc/routers/workspaces/utils/shell-env";
import { TAG_VOCABULARY } from "shared/odin-tags";
import {
	parseTranscript,
	summarizeTranscript,
	type TranscriptMessage,
	transcriptOf,
} from "./claude-sessions";

/**
 * A written brief of a session: what it's for, where it got to, what it wants
 * from you. Pasting raw transcript excerpts into the panel did not work — the
 * opening prompt is a wall of whatever language it was written in, and the last
 * assistant turn is 300 words of markdown. You have to actually read it to know
 * anything, which is the problem the panel exists to solve.
 *
 * So a model writes it. `claude -p` is already on every machine that runs this
 * app and carries its own auth, which no API-key path would.
 *
 * execWithShellEnv, not execFile: launched from the Dock, a macOS GUI app gets a
 * minimal PATH with no `claude` in it.
 */

export interface WrittenBrief {
	/** A card-sized name for the session — what it's about, not its first line. */
	title: string | null;
	goal: string | null;
	status: string | null;
	next: string | null;
	/** Board tags, always from TAG_VOCABULARY. Empty when the model offered none. */
	tags: string[];
	/** Set when the model ran but didn't answer in the shape we asked for. */
	raw: string | null;
}

/**
 * The tags the model may hand out — shared with the board, which shows and
 * filters by exactly this list. Closed on purpose: let it invent its own and
 * you get refactor/refactoring/refactors as three pills matching a third of
 * the cards each.
 */
export { TAG_VOCABULARY };

const BRIEF_TAGS: string[] = TAG_VOCABULARY.filter(
	(tag) => tag !== "automation",
);

/** Enough to place a card, few enough to read at a glance on one. */
const MAX_TAGS = 2;

/** A card is one line wide — a longer title is just truncated on screen. */
const TITLE_CAP = 60;

/** Longest single turn we feed the model. Enough for a report, not a diff. */
const TURN_CAP = 1200;
/** How many recent turns describe "where it's at" without burying it. */
const RECENT_TURNS = 14;

/**
 * The conversation, compressed to what a brief needs: the ask, then the recent
 * back-and-forth. Long turns lose their middle rather than their end — an
 * assistant turn puts its conclusion last.
 */
export function digest({
	title,
	prompt,
	messages,
}: {
	title: string | null;
	prompt: string | null;
	messages: TranscriptMessage[];
}): string {
	const clip = (text: string) =>
		text.length <= TURN_CAP
			? text
			: `${text.slice(0, TURN_CAP * 0.4)}\n…\n${text.slice(-TURN_CAP * 0.6)}`;
	const recent = messages
		.slice(-RECENT_TURNS)
		.map((m) => `[${m.role === "user" ? "HUMAN" : "AGENT"}] ${clip(m.text)}`)
		.join("\n\n");
	return [
		title ? `TITLE: ${title}` : null,
		prompt ? `OPENING REQUEST:\n${prompt.slice(0, 1500)}` : null,
		`RECENT TURNS (oldest first):\n${recent}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

const INSTRUCTIONS = `You are briefing an engineer who is about to open an in-progress agent session and needs to understand it in ten seconds.

Reply with EXACTLY five lines and nothing else. No markdown, no code fences, no preamble:
TITLE: <under 60 characters — a name for this session, as a human would title the task. No trailing period.>
GOAL: <one sentence — what this session is trying to achieve>
STATUS: <one or two sentences — what has actually been done, and where it stands right now>
NEXT: <one sentence addressed to the engineer, starting with a verb — the one thing HE has to do now (answer the prompt on screen, review a diff, decide X, merge the PR). If nothing is needed from him, say "Nothing —" and why.>
TAGS: <1-3 comma-separated tags describing the work, chosen ONLY from this list: ${BRIEF_TAGS.join(", ")}>

Rules:
- Always answer in English, even when the conversation is in another language.
- Be concrete: name the files, numbers, PRs, decisions. No filler, no "the user asked".
- Under 200 characters per line.
- TAGS: never invent a tag outside the list. Pick the fewest that fit; if none fit, leave the line empty.`;

/** Pull the four labelled lines back out; tolerate a chatty model. */
export function parseBrief(text: string): WrittenBrief {
	const field = (label: string) =>
		text
			.match(new RegExp(`^\\s*\\**${label}\\**\\s*:\\s*(.+)$`, "im"))?.[1]
			?.trim() ?? null;
	// Models like to wrap a title in quotes and end it with a full stop; a card
	// is one line wide, so what's left is cut to fit rather than by CSS.
	const title =
		(field("TITLE") ?? "")
			.replace(/^["']|["'.]+$/g, "")
			.trim()
			.slice(0, TITLE_CAP)
			.trim() || null;
	const goal = field("GOAL");
	const status = field("STATUS");
	const next = field("NEXT");
	// Anything off the list is dropped rather than corrected: a model that
	// answered "frontend" meant something, but not something the pills know.
	const allowed = new Set(BRIEF_TAGS);
	const tags = [
		...new Set(
			(field("TAGS") ?? "")
				.split(",")
				.map((tag) => tag.trim().toLowerCase().replace(/^#/, ""))
				.filter((tag) => allowed.has(tag)),
		),
	].slice(0, MAX_TAGS);
	return {
		title,
		goal,
		status,
		next,
		tags,
		raw:
			title || goal || status || next
				? null
				: text.trim().slice(0, 600) || null,
	};
}

interface CacheEntry {
	mtimeMs: number;
	writtenAt: number;
	brief: WrittenBrief;
	/** Which set of questions the model was asked. */
	version?: number;
}

/**
 * Bump when the brief gains a field, so entries written before it are rewritten
 * instead of served forever — a title-less brief on an idle session would
 * otherwise never be asked for its title.
 */
const BRIEF_VERSION = 2;

/** Survives restarts, so reopening the app doesn't re-summarise everything. */
export function defaultCachePath(): string {
	return join(homedir(), ".odin", "session-briefs.json");
}

const CACHE_MAX = 200;
/**
 * A brief costs ~15s of model time, so a busy session is not re-summarised on
 * every keystroke it writes — only once its transcript has moved AND the last
 * brief has gone cold. The panel's turn count and last-activity line come
 * straight from the transcript, so they stay live regardless.
 */
const REFRESH_AFTER_MS = 5 * 60_000;

// One store, loaded from disk on first use and rewritten after each new brief.
// Reloads if a different path is asked for, which is all the tests need.
const store: { path: string | null; entries: Map<string, CacheEntry> } = {
	path: null,
	entries: new Map(),
};

async function load(path: string): Promise<Map<string, CacheEntry>> {
	if (store.path === path) return store.entries;
	store.path = path;
	store.entries = new Map();
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<
			string,
			CacheEntry
		>;
		for (const [id, entry] of Object.entries(parsed)) {
			if (entry?.brief) store.entries.set(id, entry);
		}
	} catch {
		// no cache yet, or it's corrupt — either way, start empty
	}
	return store.entries;
}

async function save(path: string): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			JSON.stringify(Object.fromEntries(store.entries), null, 0),
		);
	} catch {
		// a cache we can't persist is still a cache
	}
}

/** One run per session at a time — the panel polls, and a spawn takes ~15s. */
const inFlight = new Map<string, Promise<WrittenBrief>>();

export async function writeBrief({
	sessionId,
	claudeBin = "claude",
	timeoutMs = 90_000,
	root,
	cachePath = defaultCachePath(),
	now = Date.now(),
}: {
	sessionId: string;
	claudeBin?: string;
	timeoutMs?: number;
	root?: string;
	cachePath?: string;
	now?: number;
}): Promise<WrittenBrief & { cached: boolean; writtenAt: number }> {
	const file = await transcriptOf(sessionId, root);
	if (!file) throw new Error("No transcript on this machine for that session");

	const cache = await load(cachePath);
	const hit = cache.get(sessionId);
	if (
		hit?.version === BRIEF_VERSION &&
		(hit.mtimeMs === file.mtimeMs || now - hit.writtenAt < REFRESH_AFTER_MS)
	) {
		return { ...hit.brief, cached: true, writtenAt: hit.writtenAt };
	}

	const running = inFlight.get(sessionId);
	if (running) {
		const brief = await running;
		return {
			...brief,
			cached: true,
			writtenAt: cache.get(sessionId)?.writtenAt ?? now,
		};
	}

	const work = (async () => {
		const jsonl = await readFile(file.path, "utf-8");
		const { aiTitle, prompt } = summarizeTranscript(jsonl);
		const body = digest({
			title: aiTitle,
			prompt,
			messages: parseTranscript(jsonl),
		});
		// `claude -p` files a transcript of its own for every run, and this one runs
		// on every card, forever — Session History filled up with thousands of
		// one-message "sessions" nobody started. Name the session so its transcript
		// can be deleted again; it is a function call, not a conversation.
		const briefSessionId = randomUUID();
		let stdout: string;
		try {
			({ stdout } = await execWithShellEnv(
				claudeBin,
				[
					"-p",
					`${INSTRUCTIONS}\n\n--- SESSION ---\n${body}`,
					"--model",
					"haiku",
					"--session-id",
					briefSessionId,
					// No MCP servers and no project context: this is a summarising call,
					// and loading either costs seconds and can hang on a broken server.
					"--strict-mcp-config",
					"--mcp-config",
					'{"mcpServers":{}}',
				],
				{ cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 1_000_000 },
			));
		} finally {
			// Also on failure: a timed-out run leaves the same litter behind.
			const litter = await transcriptOf(briefSessionId, root);
			if (litter) await rm(litter.path, { force: true });
		}
		const brief = parseBrief(stdout);
		if (cache.size >= CACHE_MAX) cache.clear(); // ponytail: cheaper than an LRU
		cache.set(sessionId, {
			mtimeMs: file.mtimeMs,
			writtenAt: now,
			brief,
			version: BRIEF_VERSION,
		});
		await save(cachePath);
		return brief;
	})();

	inFlight.set(sessionId, work);
	try {
		return { ...(await work), cached: false, writtenAt: now };
	} finally {
		inFlight.delete(sessionId);
	}
}

/**
 * Write briefs for sessions nobody has opened yet, one at a time in the
 * background — so the panel is already filled in when you click a card instead
 * of starting a 15s model call at the moment you want to read it.
 *
 * ponytail: serial, not parallel. Ten cards would otherwise fork ten `claude`
 * processes at once, and there's nobody waiting on any of them.
 */
type WarmOptions = Omit<Parameters<typeof writeBrief>[0], "sessionId">;

// Each entry carries the options it was queued with: the queue is global, so a
// session pushed while another caller's drain is in flight would otherwise be
// written with that caller's paths and binary.
const queue: { sessionId: string; options: WarmOptions }[] = [];
// Queued OR currently running. `queue` alone can't answer that: pump() shifts an
// id off before writeBrief has registered it as in-flight, and the board re-fires
// into exactly that gap.
const warming = new Set<string>();
let pumping = false;

export async function warmBriefs(
	sessionIds: string[],
	options: WarmOptions = {},
): Promise<{
	queued: number;
	tags: Record<string, string[]>;
	titles: Record<string, string>;
}> {
	let queued = 0;
	for (const id of sessionIds) {
		if (!id || warming.has(id)) continue;
		warming.add(id);
		queue.push({ sessionId: id, options });
		queued++;
	}
	void pump();
	// The tags and titles of whatever is already written. The board asks on a
	// timer, so a session queued by this call reports its own on a later one —
	// which beats a second channel just to push three words back to a card.
	const cache = await load(options.cachePath ?? defaultCachePath());
	const tags: Record<string, string[]> = {};
	const titles: Record<string, string> = {};
	for (const id of sessionIds) {
		const brief = cache.get(id)?.brief;
		if (brief?.tags?.length) tags[id] = brief.tags;
		if (brief?.title) titles[id] = brief.title;
	}
	return { queued, tags, titles };
}

async function pump(): Promise<void> {
	if (pumping) return;
	pumping = true;
	try {
		while (queue.length > 0) {
			const next = queue.shift();
			if (!next) continue;
			const { sessionId, options } = next;
			try {
				// A cache hit costs one stat, so re-warming a quiet session is free.
				await writeBrief({ ...options, sessionId });
			} catch {
				// no transcript, no claude, model failed — the panel will say so
			} finally {
				// Re-warmable next round; writeBrief's own throttle stops the waste.
				warming.delete(sessionId);
			}
		}
	} finally {
		pumping = false;
	}
}
