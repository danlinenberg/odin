import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Search over Claude Code's own conversation transcripts.
 *
 * Claude writes one JSONL per session at
 * `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`. That file is the only
 * durable record of what a session was actually about — the board's card titles
 * are whatever was typed at launch ("Work on Odin", twenty times over), and a
 * pane's scrollback is ANSI mush. So: find an old session by keyword here, then
 * resume it by its id (`claude --resume <id>`).
 */

/** Where Claude Code keeps its per-project transcripts. */
export function projectsRoot(): string {
	return join(homedir(), ".claude", "projects");
}

export interface TranscriptFile {
	/** Directory name under `projects/` — Claude's slug of the session's cwd. */
	project: string;
	sessionId: string;
	path: string;
	updatedAt: number;
	bytes: number;
}

export interface SessionSnippet {
	role: "user" | "assistant";
	text: string;
}

export interface SessionSummary {
	project: string;
	sessionId: string;
	/** Real working directory, read from the transcript itself. */
	cwd: string | null;
	/** Claude's own generated title when it has one, else the opening prompt. */
	title: string;
	/** The opening prompt, as a subtitle. Null when the session has no prose. */
	prompt: string | null;
	updatedAt: number;
	bytes: number;
	messages: number;
	matches: number;
	snippets: SessionSnippet[];
	/** Who asked for the work, when Odin launched this from a feed. */
	person: string | null;
}

/** Which feed a session was launched from, and who asked for it. */
export interface SessionPerson {
	person: string | null;
	source: string | null;
}

/**
 * What a source is called when you type it. You search for "slack", not for
 * "reactions" (the queue's internal name), and for "gh" as often as "github".
 */
const SOURCE_WORDS: Record<string, string> = {
	reactions: "slack reactions",
	slack: "slack reactions",
	pr: "pr github gh",
	jira: "jira",
	notion: "notion",
};

/** The person + source of a session, as one lowercase haystack. */
function personText(who: SessionPerson | undefined): string {
	if (!who) return "";
	return `${who.person ?? ""} ${SOURCE_WORDS[who.source ?? ""] ?? ""}`
		.trim()
		.toLowerCase();
}

/** Text that is plumbing rather than prose, when no `promptSource` says so. */
const NOISE =
	/^(<|Caveat:|\[Request interrupted|\[Image|Base directory for this skill:|This session is being continued)/;

/**
 * Claude Code files a lot of things as `type: "user"` that you never typed:
 * skill bodies, CLAUDE.md, hook output, image placeholders, task notifications,
 * slash-command markers. They're byte-identical across sessions, so searching
 * them made almost every session match the same boilerplate — the noise that
 * made this view useless. `promptSource` is the reliable discriminator (present
 * throughout the transcript history); the heuristics are only for the handful of
 * entries that lack it.
 */
const TYPED_SOURCES = new Set(["typed", "queued", "suggestion_accepted"]);

function isTypedByUser(entry: Record<string, unknown>, text: string): boolean {
	if (entry.isMeta || entry.sourceToolUseID) return false;
	const source = entry.promptSource;
	if (typeof source === "string") return TYPED_SOURCES.has(source);
	return !NOISE.test(text);
}

const MAX_SNIPPETS = 3;

/** Filter chips shown above the results — a header, not a directory. */
const MAX_ASKERS = 12;

/** Top-level transcripts, newest first. `<session>/subagents/*.jsonl` are
 * side-conversations of a session, not sessions you can resume — skipped. */
export async function listTranscripts(
	root: string = projectsRoot(),
): Promise<TranscriptFile[]> {
	let projects: string[];
	try {
		projects = (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return []; // no ~/.claude/projects yet
	}
	const files: TranscriptFile[] = [];
	for (const project of projects) {
		let entries: string[];
		try {
			entries = await readdir(join(root, project));
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(root, project, name);
			try {
				const info = await stat(path);
				if (!info.isFile()) continue;
				files.push({
					project,
					sessionId: name.slice(0, -".jsonl".length),
					path,
					updatedAt: info.mtimeMs,
					bytes: info.size,
				});
			} catch {
				// vanished mid-scan
			}
		}
	}
	return files.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Flatten a message's content to its prose; tool calls and images drop out. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && "text" in block
				? String((block as { text: unknown }).text)
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/**
 * Strip the task-file scaffolding useLaunchTaskSession wraps a prompt in:
 * `Task: <first line>\n\n<whole prompt>\n\nWork in the current workspace…`,
 * which otherwise reads as the first line stuttering.
 *
 * Slack-sourced sessions get a second layer — the two-phase ingest recipe from
 * buildThreadPrompt. That's Odin talking to itself, identical in every Slack
 * session, and it buried the actual ask in the row subtitle.
 */
function cleanPrompt(text: string): string {
	const body = text
		.replace(/^Task:\s*/i, "")
		// Both tails are the launcher's, and the attachment list (when there is
		// one) always runs to the end of the prompt.
		.replace(/\n+Attached files —[\s\S]*$/i, "")
		.replace(/\n+Work in the current workspace\.[\s\S]*$/i, "")
		.replace(/\n+PHASE 1 [—-] INGEST[\s\S]*$/i, "")
		.trim();
	const [first, ...rest] = body.split("\n\n");
	const remainder = rest.join("\n\n").trim();
	// The Task: line is the title, which is ELIDED at the launcher's length cap
	// ("…explanation of thi…") — so it only prefixes the body once the ellipsis
	// is off, and without this the prompt reads as a half-word stutter.
	const head = first?.trim().replace(/(?:…|\.\.\.)$/, "");
	return head && remainder.startsWith(head) ? remainder : body;
}

/**
 * The line `buildPrompt` (useLaunchTaskSession) ends every task prompt with.
 * Claude's JSONL records nothing about who started a session, so this sentence
 * in the opening prompt is the only durable mark of "Odin launched this" — and
 * Session History wants nothing else: sessions typed into a plain terminal
 * aren't work this app is tracking.
 *
 * ponytail: a prompt fingerprint, not a registry of launched ids. It misses
 * empty-prompt panes (nothing was typed at launch to fingerprint) and sessions
 * resumed out of a non-Odin transcript. Keep a `~/.odin/launched-sessions`
 * ledger if those ever matter — but it would start empty, hiding every session
 * to date, which this doesn't.
 */
const ODIN_LAUNCH_MARKER = /\n\s*Work in the current workspace\./i;

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split a query into keywords. You don't remember a session's exact wording —
 * you remember roughly what it was about ("optimizing datadog costs" for a
 * session titled "reduce repeating Datadog logs"), so an exact-phrase search
 * finds nothing. Terms are matched independently and the hits are ranked by how
 * many of them landed, and where.
 */
export function queryTerms(query: string): string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/[^a-z0-9_.#/-]+/)
				.filter((term) => term.length >= 2),
		),
	].slice(0, 8);
}

/** Every distinct term of `terms` present in `text`, and total occurrences. */
function countTerms(
	text: string,
	terms: string[],
): { hit: Set<string>; total: number } {
	const hit = new Set<string>();
	let total = 0;
	for (const term of terms) {
		let from = text.indexOf(term);
		if (from === -1) continue;
		hit.add(term);
		while (from !== -1) {
			total++;
			from = text.indexOf(term, from + term.length);
		}
	}
	return { hit, total };
}

/**
 * Derive a session's summary from its JSONL, optionally collecting matches for
 * `terms` (case-insensitive, over what you typed and what Claude said only —
 * injected context, tool output and file contents would bury the real hits).
 */
export function summarizeTranscript(
	jsonl: string,
	terms: string[] = [],
): Omit<
	SessionSummary,
	"project" | "sessionId" | "updatedAt" | "bytes" | "title" | "person"
> & { aiTitle: string | null; bodyTerms: Set<string>; fromOdin: boolean } {
	let aiTitle: string | null = null;
	let prompt: string | null = null;
	let fromOdin = false;
	let cwd: string | null = null;
	let messages = 0;
	let matches = 0;
	const bodyTerms = new Set<string>();
	// More candidates than we keep, so the most informative ones can win.
	const candidates: {
		role: "user" | "assistant";
		text: string;
		hits: number;
	}[] = [];

	for (const line of jsonl.split("\n")) {
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // truncated tail or a control record we don't care about
		}
		if (
			!aiTitle &&
			entry.type === "ai-title" &&
			typeof entry.aiTitle === "string"
		) {
			aiTitle = entry.aiTitle;
		}
		if (entry.type !== "user" && entry.type !== "assistant") continue;
		if (entry.isSidechain) continue; // subagent turn, not the conversation
		if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
		const role = entry.type as "user" | "assistant";
		const message = entry.message as { content?: unknown } | undefined;
		const text = messageText(message?.content).trim();
		if (!text) continue;
		// Only what you typed and what Claude said — injected context is neither,
		// and it's identical in every session, so it can't tell them apart.
		if (role === "user" && !isTypedByUser(entry, text)) continue;
		messages++;
		if (role === "user" && !prompt) {
			// Before cleanPrompt, which strips the marker off the stored prompt.
			fromOdin = ODIN_LAUNCH_MARKER.test(text);
			prompt = cleanPrompt(text).slice(0, 600) || null;
		}
		if (terms.length === 0) continue;
		const haystack = text.toLowerCase();
		const { hit, total } = countTerms(haystack, terms);
		if (hit.size === 0) continue;
		matches += total;
		for (const term of hit) bodyTerms.add(term);
		if (candidates.length < 40) {
			// Centre the passage on the first term that appears.
			const at = Math.min(
				...[...hit].map((term) => haystack.indexOf(term)).filter((i) => i >= 0),
			);
			const start = Math.max(0, at - 70);
			const end = Math.min(text.length, at + 140);
			candidates.push({
				role,
				hits: hit.size,
				text: `${start > 0 ? "…" : ""}${oneLine(text.slice(start, end))}${
					end < text.length ? "…" : ""
				}`,
			});
		}
	}
	// Prefer passages covering the most terms; your own words break ties, since
	// "what did I ask?" identifies a session better than Claude's reply.
	const snippets: SessionSnippet[] = candidates
		.sort(
			(a, b) =>
				b.hits - a.hits ||
				Number(b.role === "user") - Number(a.role === "user"),
		)
		.slice(0, MAX_SNIPPETS)
		.map(({ role, text }) => ({ role, text }));
	return {
		aiTitle,
		prompt,
		cwd,
		messages,
		matches,
		snippets,
		bodyTerms,
		fromOdin,
	};
}

function titleFor(
	aiTitle: string | null,
	prompt: string | null,
	sessionId: string,
): string {
	if (aiTitle) return aiTitle;
	if (prompt) return oneLine(prompt).slice(0, 120);
	return `session ${sessionId.slice(0, 8)}`;
}

/**
 * How well a session answers the query. A term in the title or in your opening
 * prompt says the session is *about* that thing; a term buried in turn 180 says
 * it came up once. Occurrence count only breaks ties, so one long session can't
 * outrank a session actually on the topic.
 */
function scoreOf(
	terms: string[],
	title: string,
	prompt: string | null,
	cwd: string | null,
	bodyTerms: Set<string>,
	matches: number,
): number {
	const inTitle = countTerms(title.toLowerCase(), terms).hit.size;
	const inPrompt = countTerms((prompt ?? "").toLowerCase(), terms).hit.size;
	const inRepo = countTerms((cwd ?? "").toLowerCase(), terms).hit.size;
	return (
		4 * inTitle +
		2 * inPrompt +
		inRepo +
		2 * bodyTerms.size +
		0.05 * Math.min(matches, 40)
	);
}

/**
 * Browse (empty query) or keyword-search the transcript store, restricted to
 * sessions Odin itself launched (see ODIN_LAUNCH_MARKER).
 *
 * `people` maps a session id to who asked for it — Odin knows that for every
 * session it launched off a feed, and the name appears nowhere in the
 * transcript (the prompt is the ticket, not the reporter). So it's matched and
 * ranked alongside the prose: "ofek" finds the sessions Ofek asked for, even
 * though nobody ever typed his name into one.
 *
 * ponytail: no index, whole files read (searching adds a cheap all-terms reject
 * before parsing). Measured at ~1s for a full 194-transcript / ~1GB store, which
 * a 250ms input debounce covers. If it ever drags: memoise {path,mtime} →
 * summary. Reading only each file's head would be faster, but then the message
 * count is a lie for long sessions.
 */
export async function searchSessions({
	query = "",
	limit = 40,
	maxFiles = 400,
	root = projectsRoot(),
	people = new Map(),
}: {
	query?: string;
	limit?: number;
	maxFiles?: number;
	root?: string;
	/** session id → who asked, for the sessions Odin launched off a feed. */
	people?: Map<string, SessionPerson>;
} = {}): Promise<{
	sessions: SessionSummary[];
	scanned: number;
	total: number;
	terms: string[];
	/** Everyone who has asked for something, newest first — the filter chips. */
	askers: string[];
}> {
	const files = await listTranscripts(root);
	const terms = queryTerms(query);
	// Raw-file reject: the file text is a superset of the prose, so a term absent
	// here can't be in the conversation. Saves parsing most of the store.
	const rejects = terms.map((term) => new RegExp(escapeRegExp(term), "i"));
	const scored: { session: SessionSummary; score: number }[] = [];
	let scanned = 0;

	for (const file of files) {
		// Browsing wants the newest `limit`; searching has to see everything it
		// can before ranking, or the best hit may never be read.
		if (terms.length === 0 && scored.length >= limit) break;
		if (scanned >= maxFiles) break;
		scanned++;
		const who = people.get(file.sessionId);
		// Who asked is matched before the file is even parsed — the name isn't in
		// there, so the prose reject below would throw the session away.
		const whoTerms =
			terms.length > 0
				? countTerms(personText(who), terms).hit
				: new Set<string>();
		try {
			const jsonl = await readFile(file.path, "utf-8");
			if (
				rejects.length > 0 &&
				whoTerms.size === 0 &&
				!rejects.some((re) => re.test(jsonl))
			) {
				continue;
			}
			const summary = summarizeTranscript(jsonl, terms);
			// Nothing you ever typed and no title Claude gave itself: a
			// programmatic run (`promptSource: "sdk"` — vibe-kanban and friends) or
			// a session that died before its first turn. Those list as
			// "session 2d3839e1 · 0 msgs" with nothing to read and nothing worth
			// resuming, which is the noise that drowned the real sessions.
			if (!summary.aiTitle && !summary.prompt) continue;
			// Not launched from Odin — a conversation from some other terminal,
			// which this board never tracked and can't resume into a card.
			if (!summary.fromOdin) continue;
			// Matched only in injected context or tool output — not a real hit.
			if (
				terms.length > 0 &&
				summary.bodyTerms.size === 0 &&
				whoTerms.size === 0
			)
				continue;
			const title = titleFor(summary.aiTitle, summary.prompt, file.sessionId);
			scored.push({
				// Who asked outweighs a title word: a full name matching both its
				// terms beats a session that merely says "Ofek" a lot, which is
				// what clicking a person chip has to do.
				score:
					6 * whoTerms.size +
					scoreOf(
						terms,
						title,
						summary.prompt,
						summary.cwd,
						summary.bodyTerms,
						summary.matches,
					),
				session: {
					project: file.project,
					sessionId: file.sessionId,
					updatedAt: file.updatedAt,
					bytes: file.bytes,
					title,
					prompt: summary.prompt,
					cwd: summary.cwd,
					messages: summary.messages,
					matches: summary.matches,
					snippets: summary.snippets,
					person: who?.person ?? null,
				},
			});
		} catch {
			// unreadable transcript — skip it
		}
	}
	// Best match first when searching; newest first when browsing (already sorted).
	if (terms.length > 0) {
		scored.sort(
			(a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt,
		);
	}
	// Only people whose session is still on disk — a chip that finds nothing is
	// worse than no chip. Map order is insertion order, i.e. newest first.
	const onDisk = new Set(files.map((file) => file.sessionId));
	const askers = [
		...new Set(
			[...people]
				.filter(([sessionId]) => onDisk.has(sessionId))
				.map(([, who]) => who.person)
				.filter((name): name is string => Boolean(name)),
		),
	].slice(0, MAX_ASKERS);
	return {
		sessions: scored.slice(0, limit).map((entry) => entry.session),
		scanned,
		total: files.length,
		terms,
		askers,
	};
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
	at: string | null;
}

/** The conversation, prose only — the readable form of a session. */
export function parseTranscript(
	jsonl: string,
	maxMessages = 500,
): TranscriptMessage[] {
	const messages: TranscriptMessage[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type !== "user" && entry.type !== "assistant") continue;
		if (entry.isSidechain) continue;
		const message = entry.message as { content?: unknown } | undefined;
		const text = messageText(message?.content).trim();
		if (!text) continue;
		if (entry.type === "user" && !isTypedByUser(entry, text)) continue;
		messages.push({
			role: entry.type as "user" | "assistant",
			text: text.length > 6000 ? `${text.slice(0, 6000)}\n…[truncated]` : text,
			at: typeof entry.timestamp === "string" ? entry.timestamp : null,
		});
	}
	// Keep the tail: the end of a conversation is what you resume into.
	return messages.slice(-maxMessages);
}

/** Reject anything that isn't a bare directory / file name from the renderer. */
function isSafeSegment(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/**
 * The project directory holding a session, found by id alone. A board pane
 * records the conversation id it launched with but not the directory it ran in,
 * and Claude names the directory after a cwd we'd only be guessing at — so look
 * for the file instead. One stat per project, no reads.
 */
async function projectOf(
	sessionId: string,
	root: string,
): Promise<string | null> {
	let entries: string[];
	try {
		entries = (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return null;
	}
	for (const project of entries) {
		try {
			await stat(join(root, project, `${sessionId}.jsonl`));
			return project;
		} catch {
			// not this one
		}
	}
	return null;
}

/** A session's transcript file and when it last changed, found by id alone. */
export async function transcriptOf(
	sessionId: string,
	root: string = projectsRoot(),
): Promise<{ path: string; mtimeMs: number } | null> {
	if (!isSafeSegment(sessionId)) return null;
	const project = await projectOf(sessionId, root);
	if (!project) return null;
	const path = join(root, project, `${sessionId}.jsonl`);
	try {
		return { path, mtimeMs: (await stat(path)).mtimeMs };
	} catch {
		return null;
	}
}

export async function readTranscript({
	project,
	sessionId,
	root = projectsRoot(),
}: {
	/** Omit to locate the session by id across every project. */
	project?: string;
	sessionId: string;
	root?: string;
}): Promise<{
	messages: TranscriptMessage[];
	cwd: string | null;
	/** Claude's own generated title for the conversation, when it has one. */
	title: string | null;
	/** The real opening prompt — `messages` is only the tail of a long session. */
	prompt: string | null;
	/** A `/loop` (or any schedule) still armed in this conversation. */
	loop: ActiveLoop | null;
}> {
	if (!isSafeSegment(sessionId) || (project && !isSafeSegment(project))) {
		throw new Error("Invalid transcript reference");
	}
	const dir = project ?? (await projectOf(sessionId, root));
	if (!dir) throw new Error("No transcript on this machine for that session");
	const jsonl = await readFile(join(root, dir, `${sessionId}.jsonl`), "utf-8");
	const { cwd, aiTitle, prompt } = summarizeTranscript(jsonl);
	return {
		messages: parseTranscript(jsonl),
		cwd,
		title: aiTitle,
		prompt,
		loop: activeLoop(jsonl),
	};
}

export interface ActiveLoop {
	/** "cron" = a fixed interval (`/loop 5m …`); "wakeup" = self-paced. */
	kind: "cron" | "wakeup";
	/** The cron expression, or when the next self-paced wakeup fires (ISO). */
	schedule: string;
	prompt: string | null;
}

/** Recurring cron jobs expire on their own after this long. */
const CRON_LIFETIME_MS = 7 * 86_400_000;
/** A woken turn can run a while before it books the next wakeup. */
const WAKEUP_GRACE_MS = 15 * 60_000;

/**
 * Whether this conversation is running under `/loop`, read from the schedule
 * tool calls it made: a recurring CronCreate not yet CronDeleted, or a
 * ScheduleWakeup whose fire time (plus a turn's grace) hasn't passed and that
 * wasn't a `stop`. Both only live inside the running claude process — the
 * caller has to check the session is still up.
 *
 * ponytail: crons are counted, not matched by id — the id is only in the
 * tool_result text. Match ids if sessions ever juggle several jobs.
 */
export function activeLoop(
	jsonl: string,
	now: number = Date.now(),
): ActiveLoop | null {
	const crons: ActiveLoop[] = [];
	let wakeup: { at: number; loop: ActiveLoop } | null = null;
	for (const line of jsonl.split("\n")) {
		if (!line.includes('"tool_use"')) continue;
		let entry: { timestamp?: unknown; message?: { content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const at = Date.parse(String(entry.timestamp));
		const content = entry.message?.content;
		if (!Array.isArray(content) || Number.isNaN(at)) continue;
		for (const block of content) {
			if (block?.type !== "tool_use") continue;
			const input = (block.input ?? {}) as Record<string, unknown>;
			const prompt = typeof input.prompt === "string" ? input.prompt : null;
			if (block.name === "CronCreate") {
				if (input.recurring === false || now - at > CRON_LIFETIME_MS) continue;
				crons.push({ kind: "cron", schedule: String(input.cron), prompt });
			} else if (block.name === "CronDelete") {
				crons.shift();
			} else if (block.name === "ScheduleWakeup") {
				const fireAt = at + Number(input.delaySeconds ?? 0) * 1000;
				wakeup = input.stop
					? null
					: {
							at: fireAt,
							loop: {
								kind: "wakeup",
								schedule: new Date(fireAt).toISOString(),
								prompt,
							},
						};
			}
		}
	}
	if (crons.length) return crons[crons.length - 1] as ActiveLoop;
	return wakeup && now < wakeup.at + WAKEUP_GRACE_MS ? wakeup.loop : null;
}

/** The checkout containing `dir`, or null outside a repo. */
function repoRootOf(dir: string): string | null {
	let current = dir;
	while (true) {
		// A worktree's `.git` is a file, a clone's is a directory — either is a root.
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * The repo a checkout belongs to — itself for a clone, the owning clone for a
 * worktree. A worktree's `.git` is a file pointing at
 * `<repo>/.git/worktrees/<name>`, so its owner is one read away.
 *
 * Both callers need this. The label needs it because a worktree is named after
 * the branch it holds, and a card reading `review-6460` says nothing about
 * where the work landed. The tally needs it because a session that splits its
 * time between a repo and a worktree of that same repo is working in ONE repo,
 * and counting them separately splits the vote — that is how a session with
 * 259 entries in app-web-server came out labelled `dev`.
 */
function ownerRepoOf(checkout: string): string {
	const dotGit = join(checkout, ".git");
	try {
		if (statSync(dotGit).isFile()) {
			const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(
				readFileSync(dotGit, "utf-8"),
			)?.[1];
			// Submodules point into `.git/modules/` instead and own themselves.
			const owner = gitdir?.match(/^(.*)\/\.git\/worktrees\//)?.[1];
			if (owner) return owner;
		}
	} catch {
		// Unreadable .git — the checkout is its own best answer.
	}
	return checkout;
}

/** What to call a checkout on a card: the repo's name, never the worktree's. */
export function repoNameOf(checkout: string): string {
	return basename(ownerRepoOf(checkout));
}

/**
 * The checkout a session did its work in.
 *
 * Claude Code stamps a cwd on every transcript entry, and that cwd is the
 * working directory of each individual tool call — so it hops between repos,
 * worktrees and deep subdirectories as the agent moves. Reading the *last* one
 * makes the answer depend on whichever directory the agent happened to run its
 * most recent command in: a session whose work lives in one repo will report a
 * different repo entirely after a single unrelated lookup elsewhere.
 *
 * So resolve every cwd to its checkout, tally those by the REPO that owns them,
 * and return the busiest checkout inside the busiest repo. Tallying by repo is
 * what makes a worktree count as its repo rather than as a rival to it; the
 * winner is still a checkout, because the caller diffs it. Ties go to the most
 * recent, which keeps the answer stable rather than dependent on Map ordering.
 *
 * ponytail: entry counts, not edited-file counts — the transcript records where
 * commands ran, and reading it is one file read. Weigh actual writes if a
 * chatty read-only detour in another repo ever outvotes the real work.
 */
export async function workingRepoOf(
	sessionId: string,
	root: string = projectsRoot(),
): Promise<string | null> {
	const found = await transcriptOf(sessionId, root);
	if (!found) return null;

	interface Tally {
		count: number;
		lastSeen: number;
	}
	const busiest = (a: Tally, b: Tally) =>
		a.count > b.count || (a.count === b.count && a.lastSeen > b.lastSeen);

	const perCheckout = new Map<string, Tally>();
	const checkoutOfDir = new Map<string, string | null>();
	let index = 0;
	for (const line of (await readFile(found.path, "utf-8")).split("\n")) {
		index += 1;
		let cwd: unknown;
		try {
			cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
		} catch {
			continue; // blank line, or a truncated write mid-line
		}
		if (typeof cwd !== "string" || !cwd) continue;

		if (!checkoutOfDir.has(cwd)) checkoutOfDir.set(cwd, repoRootOf(cwd));
		const checkout = checkoutOfDir.get(cwd);
		if (!checkout) continue;

		const tally = perCheckout.get(checkout);
		if (tally) {
			tally.count += 1;
			tally.lastSeen = index;
		} else {
			perCheckout.set(checkout, { count: 1, lastSeen: index });
		}
	}

	const perRepo = new Map<string, Tally>();
	for (const [checkout, tally] of perCheckout) {
		const repo = ownerRepoOf(checkout);
		const running = perRepo.get(repo);
		if (running) {
			running.count += tally.count;
			running.lastSeen = Math.max(running.lastSeen, tally.lastSeen);
		} else {
			perRepo.set(repo, { ...tally });
		}
	}

	const leader = (repos: Iterable<string>): string | null => {
		let best: string | null = null;
		let bestTally: Tally = { count: 0, lastSeen: 0 };
		for (const repo of repos) {
			const tally = perRepo.get(repo);
			if (tally && busiest(tally, bestTally)) {
				best = repo;
				bestTally = tally;
			}
		}
		return best;
	};

	// A repo whose tree holds other checkouts is a container, not the subject.
	// `~/dev` is a repo of loose scripts that also happens to contain every
	// clone, so every tool call that never cd'd anywhere votes for it — enough
	// to outscore the repo the session actually edited. When the leader holds
	// other candidates, the work is in one of those.
	let winner = leader(perRepo.keys());
	while (winner) {
		const nested = [...perRepo.keys()].filter((repo) =>
			repo.startsWith(`${winner}/`),
		);
		if (!nested.length) break;
		// Strictly deeper each pass, so this terminates.
		winner = leader(nested);
	}
	if (!winner) return null;

	// The repo is decided; hand back the checkout inside it the session used
	// most, since that is the tree with the changes in it.
	let best: string | null = null;
	let bestTally: Tally = { count: 0, lastSeen: 0 };
	for (const [checkout, tally] of perCheckout) {
		if (ownerRepoOf(checkout) === winner && busiest(tally, bestTally)) {
			best = checkout;
			bestTally = tally;
		}
	}
	return best;
}

/**
 * What a session was about, in one line.
 *
 * `cleanPrompt` keeps the whole Slack preamble on purpose — Session History
 * searches it — but a one-line label has room for the ask and nothing else. So
 * when Odin quoted the thread, the quote IS the title, and the framing above it
 * ("This task comes from a Slack thread: <url>") is dropped.
 */
function titleFromPrompt(prompt: string): string {
	const posted = prompt.split(/\n\s*What was posted there:\s*\n/)[1];
	return oneLine(
		(posted ?? prompt)
			.replace(/^\s*This task comes from a Slack thread:.*$/gim, "")
			.trim(),
	).slice(0, 200);
}

/**
 * The opening ask of a session, for labelling it in a list.
 *
 * Only the head of the file is looked at: the first thing you typed is within
 * the first few entries, and the alternative — parsing whole transcripts for a
 * string that lives in line three — is what makes a whole-store scan expensive.
 * Sessions that open with nothing typed (a resume, an empty pane) have no
 * answer, which is honest; the caller names them by id.
 */
export function firstPrompt(jsonl: string, headBytes = 300_000): string | null {
	for (const line of jsonl.slice(0, headBytes).split("\n")) {
		// A clipped final line can't be parsed; skip it rather than throw.
		if (!line.endsWith("}")) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type !== "user" || entry.isSidechain) continue;
		const message = entry.message as { content?: unknown } | undefined;
		const text = messageText(message?.content).trim();
		if (!text || !isTypedByUser(entry, text)) continue;
		return titleFromPrompt(cleanPrompt(text)) || null;
	}
	return null;
}
