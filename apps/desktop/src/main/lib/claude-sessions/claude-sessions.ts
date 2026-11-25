import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { launchRequest } from "renderer/routes/_authenticated/_odin/board/launch-request";
import {
	parseShell,
	type Shell,
} from "renderer/routes/_authenticated/_odin/board/shell-output";
import { toolDescription } from "renderer/routes/_authenticated/_odin/board/tool-description";
import { PR_RULES_HEADER } from "shared/odin-rules";
import { isInterruptMarker, withoutWrapping } from "shared/user-text";
import {
	assetDepth,
	idsInText,
	idsInToolInput,
	idsInUrl,
	urlQuery,
} from "./asset-ids";
import { credentialReader, type SessionCredential } from "./credential";
import { feedLine, feedLines, type LineReader } from "./lines";
import { type McpSignedOut, mcpSignedOutReader } from "./mcp-sign-in";
import { type SessionUsage, usageReader } from "./usage";

/**
 * Search over Claude Code's own conversation transcripts.
 *
 * Claude writes one JSONL per session at
 * `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`. That file is the only
 * durable record of what a session was actually about - the board's card titles
 * are whatever was typed at launch ("Work on Odin", twenty times over), and a
 * pane's scrollback is ANSI mush. So: find an old session by keyword here, then
 * resume it by its id (`claude --resume <id>`).
 */

/** Where Claude Code keeps its per-project transcripts. */
export function projectsRoot(): string {
	return join(homedir(), ".claude", "projects");
}

export interface TranscriptFile {
	/** Directory name under `projects/` - Claude's slug of the session's cwd. */
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
	/** The card's title as launched, else Claude's generated one, else the prompt. */
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
 * them made almost every session match the same boilerplate - the noise that
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

/** Filter chips shown above the results - a header, not a directory. */
const MAX_ASKERS = 12;

/** Top-level transcripts, newest first. `<session>/subagents/*.jsonl` are
 * side-conversations of a session, not sessions you can resume - skipped. */
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
 * Slack-sourced sessions get a second layer - the two-phase ingest recipe from
 * buildThreadPrompt. That's Odin talking to itself, identical in every Slack
 * session, and it buried the actual ask in the row subtitle.
 */
function cleanPrompt(text: string): string {
	const body = text
		.replace(/^Task:\s*/i, "")
		// Both tails are the launcher's, and the attachment list (when there is
		// one) always runs to the end of the prompt.
		.replace(/\n+Attached files [\u2014-][\s\S]*$/i, "")
		.replace(/\n+Work in the current workspace\.[\s\S]*$/i, "")
		.replace(/\n+PHASE 1 [\u2014-] INGEST[\s\S]*$/i, "")
		.trim();
	const [first, ...rest] = body.split("\n\n");
	const remainder = rest.join("\n\n").trim();
	// The Task: line is the title, which is ELIDED at the launcher's length cap
	// ("…explanation of thi…") - so it only prefixes the body once the ellipsis
	// is off, and without this the prompt reads as a half-word stutter.
	const head = first?.trim().replace(/(?:…|\.\.\.)$/, "");
	return head && remainder.startsWith(head) ? remainder : body;
}

/**
 * The line `buildPrompt` (useLaunchTaskSession) ends every task prompt with.
 * Claude's JSONL records nothing about who started a session, so this sentence
 * in the opening prompt is the only durable mark of "Odin launched this" - and
 * Session History wants nothing else: sessions typed into a plain terminal
 * aren't work this app is tracking.
 */
const ODIN_LAUNCH_MARKER = /\n\s*Work in the current workspace\./i;

/**
 * `<command-name>/x</command-name>…<command-args>a</command-args>` as `/x a`.
 * A bare command (`/clear`) is housekeeping, not something you asked: null.
 */
export function slashCommand(text: string): string | null {
	const name = /<command-name>(\/[^<]+)<\/command-name>/.exec(text)?.[1];
	const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1];
	return name && args?.trim() ? `${name} ${args.trim()}` : null;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Split a query into keywords. You don't remember a session's exact wording -
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
 * `terms` (case-insensitive, over what you typed and what Claude said only -
 * injected context, tool output and file contents would bury the real hits).
 */
export function summarizeTranscript(jsonl: string, terms: string[] = []) {
	return scoreDigest(digestTranscript(jsonl), terms);
}

/**
 * What a search reads from one transcript: its title, opening prompt and
 * where it ran, and every turn you typed or Claude wrote - a few percent of
 * the file, which is mostly tool output. Kept per file between searches.
 */
type TranscriptDigest = {
	aiTitle: string | null;
	cardTitle: string | null;
	prompt: string | null;
	fromOdin: boolean;
	cwd: string | null;
	turns: { role: "user" | "assistant"; text: string }[];
	/** The ids of what it worked on: its MCP calls' inputs and the links in
	 *  its prose (asset-ids.ts), for finding it from a page's URL. */
	ids: Set<string>;
};

function digestTranscript(jsonl: string): TranscriptDigest {
	const reader = digestReader();
	feedLines(jsonl, reader);
	return reader.result();
}

/**
 * digestTranscript, a line at a time - see LineReader. Without `turnsToo` it
 * keeps only the title, prompt and cwd, not every turn's text a search needs.
 */
function digestReader(
	turnsToo = true,
): LineReader & { result(): TranscriptDigest } {
	let aiTitle: string | null = null;
	let cardTitle: string | null = null;
	let prompt: string | null = null;
	let fromOdin = false;
	let cwd: string | null = null;
	let cwdHere = false;
	const seen = new Set<string>();
	const turns: TranscriptDigest["turns"] = [];
	const ids = new Set<string>();
	return {
		line(line, parse) {
			if (!line) return;
			const entry = parse() as Record<string, unknown> | undefined;
			// A truncated tail or a control record we don't care about.
			if (entry === undefined) return;
			if (
				!aiTitle &&
				entry.type === "ai-title" &&
				typeof entry.aiTitle === "string"
			) {
				aiTitle = entry.aiTitle;
			}
			if (entry.type !== "user" && entry.type !== "assistant") return;
			if (entry.isSidechain) return; // subagent turn, not the conversation
			// Where it started - or, for a session moved here from the remote host
			// (Run here), the first folder on this computer: its copy is filed
			// under that folder, and its opening rows still name the host's. Resume
			// ran `claude --resume` in the host's folder here and exited 1.
			if (typeof entry.cwd === "string" && !cwdHere && !seen.has(entry.cwd)) {
				seen.add(entry.cwd);
				const here = ranHere(entry.cwd);
				if (!cwd || here) {
					cwd = entry.cwd;
					cwdHere = here;
				}
			}
			const role = entry.type as "user" | "assistant";
			const message = entry.message as { content?: unknown } | undefined;
			if (turnsToo && role === "assistant" && Array.isArray(message?.content))
				for (const block of message.content)
					if (block?.type === "tool_use") idsInToolInput(block.input, ids);
			const raw = messageText(message?.content).trim();
			if (!raw) return;
			// A session started with a skill (`/skill <task>`) opens on Claude
			// Code's command wrapper, with no promptSource and a leading `<` that
			// reads as injected: unwrapped, it is the launch prompt it always was.
			const command = role === "user" ? slashCommand(raw) : null;
			const text = command ?? raw;
			// Only what you typed and what Claude said - injected context is neither,
			// and it's identical in every session, so it can't tell them apart.
			if (role === "user" && !command && !isTypedByUser(entry, text)) return;
			if (turnsToo) {
				turns.push({ role, text });
				idsInText(text, ids);
			}
			if (role === "user" && !prompt) {
				// Before cleanPrompt, which strips the marker off the stored prompt.
				fromOdin = ODIN_LAUNCH_MARKER.test(text);
				// buildPrompt's first line is the card's title - `Task: <title>` or
				// `/<skill> <title>` - which is what the board showed, and what a
				// person remembers the session by.
				cardTitle =
					/^(?:Task:|\/[\w:-]+)[ \t]+(.+)/.exec(text)?.[1]?.trim() || null;
				prompt = cleanPrompt(text).slice(0, 600) || null;
			}
		},
		result: () => ({ aiTitle, cardTitle, prompt, fromOdin, cwd, turns, ids }),
	};
}

function scoreDigest(
	digest: TranscriptDigest,
	terms: string[],
): Omit<
	SessionSummary,
	"project" | "sessionId" | "updatedAt" | "bytes" | "title" | "person"
> & {
	aiTitle: string | null;
	cardTitle: string | null;
	bodyTerms: Set<string>;
	fromOdin: boolean;
} {
	const { aiTitle, cardTitle, prompt, fromOdin, cwd } = digest;
	let matches = 0;
	const bodyTerms = new Set<string>();
	// More candidates than we keep, so the most informative ones can win.
	const candidates: {
		role: "user" | "assistant";
		text: string;
		hits: number;
	}[] = [];
	for (const { role, text } of terms.length > 0 ? digest.turns : []) {
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
		cardTitle,
		prompt,
		cwd,
		messages: digest.turns.length,
		matches,
		snippets,
		bodyTerms,
		fromOdin,
	};
}

function titleFor(
	cardTitle: string | null,
	aiTitle: string | null,
	prompt: string | null,
	sessionId: string,
): string {
	if (cardTitle) return cardTitle;
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
 * `people` maps a session id to who asked for it - Odin knows that for every
 * session it launched off a feed, and the name appears nowhere in the
 * transcript (the prompt is the ticket, not the reporter). So it's matched and
 * ranked alongside the prose: "olivia" finds the sessions Olivia asked for, even
 * though nobody ever typed his name into one.
 */
/**
 * Transcript digests by path, kept while the file's size and mtime hold: a
 * search reads the store once, and the next query (every pause in typing on
 * the phone) matches only what changed. About 20 MB for 400 sessions; files
 * that fall out of the newest `maxFiles` are dropped after a search.
 */
const digests = new Map<string, { key: string; digest: TranscriptDigest }>();

export async function searchSessions({
	query = "",
	limit = 40,
	maxFiles = 400,
	root = projectsRoot(),
	people = new Map(),
	titles = {},
	cursor = 0,
	includes = () => true,
}: {
	query?: string;
	limit?: number;
	/** Browsing only: the transcript index to resume from (a previous `nextCursor`). */
	cursor?: number;
	maxFiles?: number;
	root?: string;
	/** session id → who asked, for the sessions Odin launched off a feed. */
	people?: Map<string, SessionPerson>;
	/** session id → the name the board gave it (a rename, the brief's title),
	 *  which outranks anything the transcript says. */
	titles?: Record<string, string>;
	/** Which sessions to list at all - the active profile's, from the router. */
	includes?: (sessionId: string) => boolean;
} = {}): Promise<{
	sessions: SessionSummary[];
	scanned: number;
	total: number;
	terms: string[];
	/** Where the next browse page starts; null when searching or out of files. */
	nextCursor: number | null;
	/** Everyone who has asked for something, newest first - the filter chips. */
	askers: string[];
}> {
	const files = await listTranscripts(root);
	// A pasted page URL finds the sessions that worked on what it shows, by
	// the ids in it (asset-ids.ts), not by keywords.
	const assetUrl = urlQuery(query);
	const urlIds = assetUrl ? idsInUrl(assetUrl) : [];
	const terms = urlIds.length > 0 ? [] : queryTerms(query);
	const searching = terms.length > 0 || urlIds.length > 0;
	const kept = new Set<string>();
	const scored: { session: SessionSummary; score: number }[] = [];
	let scanned = 0;
	const start = searching ? 0 : cursor;
	let index = start;
	// A session moved between machines has its log twice (the mirror and the
	// moved copy): the newest one stands for it, as files run newest first.
	const seen = new Set<string>();

	for (; index < files.length; index++) {
		const file = files[index];
		if (seen.has(file.sessionId)) continue;
		seen.add(file.sessionId);
		if (!includes(file.sessionId)) continue;
		// Browsing wants the newest `limit`; searching has to see everything it
		// can before ranking, or the best hit may never be read.
		if (!searching && scored.length >= limit) break;
		if (scanned >= maxFiles) break;
		scanned++;
		const who = people.get(file.sessionId);
		// Who asked is matched before the file is even parsed - the name isn't in
		// there, so the prose reject below would throw the session away.
		const whoTerms =
			terms.length > 0
				? countTerms(personText(who), terms).hit
				: new Set<string>();
		try {
			const key = `${file.bytes}:${file.updatedAt}`;
			let digest = digests.get(file.path);
			if (digest?.key !== key) {
				digest = {
					key,
					digest: digestTranscript(await readFile(file.path, "utf-8")),
				};
				digests.set(file.path, digest);
			}
			kept.add(file.path);
			const summary = scoreDigest(digest.digest, terms);
			// Nothing you ever typed and no title Claude gave itself: a
			// programmatic run (`promptSource: "sdk"` - vibe-kanban and friends) or
			// a session that died before its first turn. Those list as
			// "session 2d3839e1 · 0 msgs" with nothing to read and nothing worth
			// resuming, which is the noise that drowned the real sessions.
			if (!summary.aiTitle && !summary.prompt) continue;
			// Not launched from Odin - a conversation from some other terminal,
			// which this board never tracked and can't resume into a card.
			if (!summary.fromOdin) continue;
			const depth = assetDepth(urlIds, digest.digest.ids);
			if (urlIds.length > 0 && depth === 0) continue;
			// Matched only in injected context or tool output - not a real hit.
			if (
				terms.length > 0 &&
				summary.bodyTerms.size === 0 &&
				whoTerms.size === 0
			)
				continue;
			const title =
				titles[file.sessionId] ||
				titleFor(
					summary.cardTitle,
					summary.aiTitle,
					summary.prompt,
					file.sessionId,
				);
			scored.push({
				// Who asked outweighs a title word: a full name matching both its
				// terms beats a session that merely says "Olivia" a lot, which is
				// what clicking a person chip has to do.
				score:
					depth +
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
			// unreadable transcript - skip it
		}
	}
	// A search walks the newest maxFiles: anything it didn't is gone or older.
	if (searching)
		for (const path of digests.keys())
			if (!kept.has(path)) digests.delete(path);
	// Best match first when searching; newest first when browsing (already sorted).
	if (searching) {
		scored.sort(
			(a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt,
		);
	}
	// Only people whose session is still on disk - a chip that finds nothing is
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
	// A URL lists only the sessions on its most specific thing any session
	// touched: the frame's sessions, not every session that opened the file.
	const best = scored[0]?.score ?? 0;
	const listed =
		urlIds.length > 0 ? scored.filter((entry) => entry.score === best) : scored;
	return {
		sessions: listed.slice(0, limit).map((entry) => entry.session),
		scanned,
		total: files.length,
		terms,
		nextCursor: !searching && index < files.length ? index : null,
		askers,
	};
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
	at: string | null;
	/** PR urls `gh pr create` printed: this session opened them. */
	opened?: true;
	/** Branches this session pushed from the turn this message belongs to. */
	pushed?: string[];
	/** Pasted images as data URLs, only when asked for (`withImages`). */
	images?: string[];
	/** A `!` command and its output, only when asked for (`withShells`). */
	shell?: Shell;
}

/**
 * What you said in a user turn, as the board's chat reads it (userText in
 * ChatView): a background agent's notice or a local command's output is not
 * you, even when Claude Code files it as queued input; reminders go; a slash
 * command is itself.
 */
export function spokenText(text: string): string | null {
	const command = text.match(/<command-name>([^<]*)<\/command-name>/);
	if (command) return command[1] || null;
	if (/^\s*<(local-command|task-notification)/.test(text)) return null;
	if (isInterruptMarker(text)) return null;
	return (
		withoutWrapping(
			text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ""),
		) || null
	);
}

/** Output a shell card keeps: its end, where the result and the error are. */
const SHELL_CHARS = 4000;
const lastChars = (text: string) =>
	text.length > SHELL_CHARS ? `…\n${text.slice(-SHELL_CHARS)}` : text;

/**
 * A `!` run as one message: output folds into the command just before it,
 * as the board's chat does; an empty run with no command shows nothing.
 */
function pushShell(
	messages: TranscriptMessage[],
	shell: Shell,
	at: string | null,
): void {
	const trimmed = {
		...shell,
		stdout: lastChars(shell.stdout),
		stderr: lastChars(shell.stderr),
	};
	const last = messages.at(-1)?.shell;
	if (
		shell.command === undefined &&
		last?.command !== undefined &&
		!last.stdout &&
		!last.stderr
	) {
		last.stdout = trimmed.stdout;
		last.stderr = trimmed.stderr;
		return;
	}
	if (shell.command === undefined && !shell.stdout && !shell.stderr) return;
	messages.push({
		role: "user",
		text: shell.command ?? "",
		at,
		shell: trimmed,
	});
}

/** A message's pasted images, as data URLs. */
function base64Images(content: unknown[]): string[] {
	return content.flatMap((block) => {
		const image = block as {
			type?: string;
			source?: { type?: string; media_type?: string; data?: string };
		};
		return image?.type === "image" && image.source?.type === "base64"
			? [`data:${image.source.media_type};base64,${image.source.data}`]
			: [];
	});
}

/** An ACTION ITEMS line, in the shapes splitActionItems reads. */
const ACTION_ITEMS = /^[#>*_\s]*ACTION ITEMS\b/gim;

/** Where a `! command` block opens: `!` on its first line, or as the fence's language (```!). */
const BANG_BLOCK = /```(?:[^\n]*\n\s*!|![ \t]*\n)/g;

/**
 * A message cut to `max` characters. A reply ends on its `!` commands and
 * ACTION ITEMS, and the phone and the brief read them there, so a long reply
 * loses the middle of its body, never those.
 */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = (at: number) => text.length - at <= max / 2;
	const items = [...text.matchAll(ACTION_ITEMS)].at(-1)?.index;
	const blocks = [...text.matchAll(BANG_BLOCK)]
		.map((match) => match.index)
		.filter(keep);
	const at = Math.min(
		...blocks,
		items !== undefined && keep(items) ? items : Number.POSITIVE_INFINITY,
	);
	if (!Number.isFinite(at)) return `${text.slice(0, max)}\n…[truncated]`;
	const tail = text.slice(at);
	return `${text.slice(0, max - tail.length)}\n…[truncated]\n\n${tail}`;
}

/** The conversation, prose only - the readable form of a session. */
export function parseTranscript(
	jsonl: string,
	maxMessages = 500,
	maxChars = 6000,
	withImages = false,
	withShells = false,
): TranscriptMessage[] {
	const reader = messagesReader(maxChars, withImages, withShells);
	feedLines(jsonl, reader);
	// Keep the tail: the end of a conversation is what you resume into.
	return reader.messages.slice(-maxMessages);
}

/**
 * parseTranscript, a line at a time - see LineReader. `messages` only grows,
 * so a caller may take the new ones off its front between lines, except with
 * `withShells`: a shell's output folds into the message before it.
 */
function messagesReader(
	maxChars: number,
	withImages: boolean,
	withShells: boolean,
): LineReader & { messages: TranscriptMessage[] } {
	const messages: TranscriptMessage[] = [];
	const prCreates = new Set<string>();
	// Artifact publishes by tool_use id: the label and summary the brief shows.
	const publishes = new Map<string, { title: string; description: string }>();
	return {
		messages,
		line(line, parse) {
			if (!line) return;
			const entry = parse() as Record<string, unknown> | undefined;
			if (entry === undefined) return;
			// A message sent while Claude works waits as an attachment, and is
			// the user's turn all the same.
			// A background agent's notice queues the same way: only a human's counts.
			const queued = entry.attachment as
				| { type?: string; prompt?: unknown; origin?: { kind?: string } }
				| undefined;
			if (entry.type === "attachment" && queued?.type === "queued_command") {
				const human = !queued.origin?.kind || queued.origin.kind === "human";
				const text = spokenText(messageText(queued.prompt).trim());
				const images =
					withImages && Array.isArray(queued.prompt)
						? base64Images(queued.prompt)
						: [];
				if (text && human && !entry.isSidechain)
					messages.push({
						...(images.length ? { images } : {}),
						role: "user",
						text,
						at: typeof entry.timestamp === "string" ? entry.timestamp : null,
					});
				return;
			}
			if (entry.type !== "user" && entry.type !== "assistant") return;
			if (entry.isSidechain) return;
			const message = entry.message as { content?: unknown } | undefined;
			// A PR the session opened is its output even when the reply only says
			// "#232": lift the url `gh pr create` printed into Claude's side of the
			// conversation, where the brief looks for PRs.
			if (Array.isArray(message?.content)) {
				for (const block of message.content) {
					// A push to a PR's branch makes that PR this session's work too,
					// even one it didn't open. Kept on the latest message so the
					// conversation itself doesn't change.
					const branches =
						block?.type === "tool_use" && block.name === "Bash"
							? pushedBranches(String(block.input?.command ?? ""))
							: [];
					const last = messages[messages.length - 1];
					if (branches.length && last)
						last.pushed = [...new Set([...(last.pushed ?? []), ...branches])];
					if (
						block?.type === "tool_use" &&
						block.name === "Bash" &&
						opensPr(String(block.input?.command ?? ""))
					)
						prCreates.add(block.id);
					else if (
						block?.type === "tool_use" &&
						block.name === "Artifact" &&
						(block.input?.action ?? "publish") === "publish" &&
						!block.input?.asset
					)
						publishes.set(block.id, {
							title: String(
								block.input?.title ??
									basename(
										String(block.input?.file_path ?? "Artifact"),
										".html",
									),
							),
							description: String(block.input?.description ?? ""),
						});
					else if (
						block?.type === "tool_result" &&
						publishes.has(block.tool_use_id)
					) {
						// "Published <file> at <url>" - the reply often never repeats the
						// link, and the brief only reads Claude's side for it.
						const url = messageText(block.content).match(ARTIFACT_URL)?.[0];
						const publish = publishes.get(block.tool_use_id);
						if (url && publish)
							messages.push({
								role: "assistant",
								// A table row: the brief's hover reads the cells after the
								// link as what it is.
								text: `| [${publish.title}](${url}) | ${publish.description} |`,
								at:
									typeof entry.timestamp === "string" ? entry.timestamp : null,
							});
					} else if (
						block?.type === "tool_result" &&
						prCreates.has(block.tool_use_id)
					) {
						const urls = messageText(block.content).match(PR_URL);
						if (urls)
							messages.push({
								role: "assistant",
								text: urls.join("\n"),
								at:
									typeof entry.timestamp === "string" ? entry.timestamp : null,
								opened: true,
							});
					}
				}
			}
			const raw = messageText(message?.content).trim();
			if (!raw) return;
			const shell =
				withShells && entry.type === "user" && !entry.isMeta
					? parseShell(raw)
					: null;
			if (shell) {
				pushShell(
					messages,
					shell,
					typeof entry.timestamp === "string" ? entry.timestamp : null,
				);
				return;
			}
			if (entry.type === "user" && !isTypedByUser(entry, raw)) return;
			const text = entry.type === "user" ? spokenText(raw) : raw;
			if (!text) return;
			const images =
				withImages && entry.type === "user" && Array.isArray(message?.content)
					? base64Images(message.content)
					: [];
			messages.push({
				...(images.length ? { images } : {}),
				role: entry.type as "user" | "assistant",
				text: clip(text, maxChars),
				at: typeof entry.timestamp === "string" ? entry.timestamp : null,
			});
		},
	};
}

const ANY_URL = /https:\/\/[^\s)>\]"'`|]+/g;

/**
 * Every turn that quotes a URL, across the whole conversation, cut down to
 * the lines that quote one. The brief finds its Slack thread, ticket, PRs and
 * Notion page in these: `parseTranscript` keeps only the tail, and in a long
 * session the thread you started from and the ticket you pasted are the first
 * messages to fall out of it. The rest of the line is what the session said
 * the link is - the brief's hover reads it.
 */
export function transcriptLinks(jsonl: string): TranscriptMessage[] {
	return parseTranscript(
		jsonl,
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
	).flatMap((message) => linkOf(message) ?? []);
}

/**
 * A message cut down to its lines that quote a URL; null when none does. A
 * launch prompt counts only the request you typed: the rules and the voice
 * samples Odin adds after it quote links of their own, and the brief showed
 * them as the task's thread and ticket.
 */
function linkOf(message: TranscriptMessage): TranscriptMessage | null {
	const text =
		message.role === "user"
			? (launchRequest(message.text) ?? message.text)
			: message.text;
	const lines = text
		.split("\n")
		.flatMap((line) =>
			line.length > 600 ? (line.match(ANY_URL) ?? []) : [line],
		)
		.filter((line) => line.includes("https://"));
	return lines.length ? { ...message, text: lines.join("\n") } : null;
}

/** Reject anything that isn't a bare directory / file name from the renderer. */
function isSafeSegment(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/**
 * The project directory holding a session, found by id alone. A board pane
 * records the conversation id it launched with but not the directory it ran in,
 * and Claude names the directory after a cwd we'd only be guessing at - so look
 * for the file instead. One stat per project, no reads.
 *
 * A session can have a copy in more than one folder: a remote session's
 * mirror under the host's folder name, the copy Run on this computer filed
 * under the checkout it landed in, a mirror an older Odin filed under the
 * host's name. Only one of them is still being written, and that is the one
 * to read: taking the first folder listed left the chat view tailing a copy
 * nobody wrote to any more, while your replies and Claude's landed in the
 * other. The last written wins; written at the same moment (a symlinked
 * twin), the larger.
 */
async function projectOf(
	sessionId: string,
	root: string,
): Promise<string | null> {
	// Polled per live card and per open drawer: listing every project and
	// stat-ing the file in each was redone on every call. The folders that hold
	// a copy are remembered, and only those are stat-ed each call, so the copy
	// written last still wins at once. A full listing runs again after a short
	// while, or when none of the remembered copies is there any more.
	const key = `${root}\0${sessionId}`;
	const cached = copiesCache.get(key);
	if (cached && Date.now() - cached.at < COPIES_RESCAN_MS) {
		const newest = await newestCopy(sessionId, root, cached.projects);
		if (newest) return newest.project;
	}
	let entries: string[];
	try {
		entries = (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return null;
	}
	const copies = await copiesOf(sessionId, root, entries);
	if (copies.length > 0)
		copiesCache.set(key, {
			at: Date.now(),
			projects: copies.map((copy) => copy.project),
		});
	else copiesCache.delete(key);
	return pickNewest(copies)?.project ?? null;
}

const COPIES_RESCAN_MS = 60_000;
const copiesCache = new Map<string, { at: number; projects: string[] }>();

/**
 * A copy of this conversation was just written to a folder projectOf has not
 * seen: the next lookup lists every folder again. A session moved here from
 * the remote host gets its copy under its new folder while the host's mirror
 * is the only one remembered; read from the mirror, its Resume went back to
 * the host.
 */
export function forgetCopies(sessionId: string): void {
	for (const key of copiesCache.keys())
		if (key.endsWith(`\0${sessionId}`)) copiesCache.delete(key);
}

interface Copy {
	project: string;
	mtimeMs: number;
	size: number;
}

async function copiesOf(
	sessionId: string,
	root: string,
	projects: string[],
): Promise<Copy[]> {
	const stats = await Promise.all(
		projects.map((project) =>
			stat(join(root, project, `${sessionId}.jsonl`)).then(
				({ mtimeMs, size }): Copy => ({ project, mtimeMs, size }),
				() => null,
			),
		),
	);
	return stats.filter((copy): copy is Copy => copy !== null);
}

async function newestCopy(
	sessionId: string,
	root: string,
	projects: string[],
): Promise<Copy | null> {
	return pickNewest(await copiesOf(sessionId, root, projects));
}

function pickNewest(copies: Copy[]): Copy | null {
	let newest: Copy | null = null;
	for (const copy of copies)
		if (
			!newest ||
			copy.mtimeMs > newest.mtimeMs ||
			(copy.mtimeMs === newest.mtimeMs && copy.size > newest.size)
		)
			newest = copy;
	return newest;
}

/** The folder a transcript's last turn ran in. */
export function lastCwd(transcript: string): string | null {
	const lines = transcript.trimEnd().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const cwd = JSON.parse(lines[i] ?? "")?.cwd;
			if (typeof cwd === "string" && cwd) return cwd;
		} catch {}
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

type ParsedTranscript = Awaited<ReturnType<typeof readTranscript>>;

/** What readTranscript keeps of the conversation: its tail, each clipped. */
const TAIL_MESSAGES = 500;
const MESSAGE_CHARS = 6000;
/** How much of a transcript one read takes in at a time. */
const READ_CHUNK = 8 * 1024 * 1024;
/**
 * Bytes at the start and just before the read point, compared on each read
 * to spot a rewritten file (Claude Code only appends to a transcript).
 */
const HEAD_BYTES = 4096;
const SEAM_BYTES = 64;

/**
 * A transcript read so far: how far, and what each reader made of the lines
 * up to there - never the file's text. A live session's file grows every
 * turn and the board polls it each minute, so a poll reads only the bytes
 * written since its last one. Reparsing the whole file each time took 1.7s
 * of the main process and ~1GB for a 300MB transcript.
 */
type TranscriptState = {
	ino: number;
	mtimeMs: number;
	/** Bytes read, an unfinished last line included. */
	size: number;
	/** The file's first HEAD_BYTES and the SEAM_BYTES before `size`, as read. */
	head: Buffer;
	seam: Buffer;
	/** A last line not finished yet: the next read completes it. */
	tail: Buffer;
	/**
	 * The file itself. Usually <cwd's slug>/<id>.jsonl, but a remote
	 * session's copy sits under the host's paths, so the chat view reads
	 * this rather than rebuilding it from cwd.
	 */
	path: string;
	readers: LineReader[];
	digest: ReturnType<typeof digestReader>;
	tailIn: ReturnType<typeof messagesReader>;
	linksIn: ReturnType<typeof messagesReader>;
	loop: ReturnType<typeof loopReader>;
	rules: ReturnType<typeof ruleFiringsReader>;
	usage: ReturnType<typeof usageReader>;
	credential: ReturnType<typeof credentialReader>;
	mcp: ReturnType<typeof mcpSignedOutReader>;
	drafts: ReturnType<typeof slackDraftsReader>;
	pending: ReturnType<typeof pendingPromptReader>;
	messages: TranscriptMessage[];
	links: TranscriptMessage[];
	linkChars: number;
	/** Where its last turn ran, so `local` is checked again on every read. */
	lastRan: string | null;
	result: Omit<ParsedTranscript, "local" | "loop"> | null;
};

function freshState(
	ino: number,
	path: string,
	withImages: boolean,
): TranscriptState {
	const state: TranscriptState = {
		ino,
		mtimeMs: 0,
		size: 0,
		head: Buffer.alloc(0),
		seam: Buffer.alloc(0),
		tail: Buffer.alloc(0),
		path,
		readers: [],
		digest: digestReader(false),
		tailIn: messagesReader(MESSAGE_CHARS, withImages, false),
		// Unclipped and without images, as transcriptLinks reads them.
		linksIn: messagesReader(Number.POSITIVE_INFINITY, false, false),
		loop: loopReader(),
		rules: ruleFiringsReader(),
		usage: usageReader(),
		credential: credentialReader(),
		mcp: mcpSignedOutReader(),
		drafts: slackDraftsReader(),
		pending: pendingPromptReader(),
		messages: [],
		links: [],
		linkChars: 0,
		lastRan: null,
		result: null,
	};
	const lastRan: LineReader = {
		// lastCwd, forwards.
		line(_line, parse) {
			const cwd = (parse() as { cwd?: unknown } | null | undefined)?.cwd;
			if (typeof cwd === "string" && cwd) state.lastRan = cwd;
		},
	};
	state.readers = [
		state.digest,
		state.tailIn,
		state.linksIn,
		lastRan,
		state.loop,
		state.rules,
		state.usage,
		state.credential,
		state.mcp,
		state.drafts,
		state.pending,
	];
	return state;
}

/** Feed whole lines to every reader, and move the messages they made out. */
function feedState(state: TranscriptState, text: string): void {
	for (const line of text.split("\n")) feedLine(line, state.readers);
	for (const message of state.tailIn.messages.splice(0))
		state.messages.push(message);
	if (state.messages.length > 2 * TAIL_MESSAGES)
		state.messages.splice(0, state.messages.length - TAIL_MESSAGES);
	for (const message of state.linksIn.messages.splice(0)) {
		const link = linkOf(message);
		if (!link) continue;
		state.links.push(link);
		state.linkChars += link.text.length;
	}
}

/** Read what was written since `state` was, line by line, in chunks. */
async function readOn(
	file: Awaited<ReturnType<typeof open>>,
	state: TranscriptState,
	size: number,
): Promise<void> {
	while (state.size < size) {
		const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, size - state.size));
		const { bytesRead } = await file.read(chunk, 0, chunk.length, state.size);
		if (!bytesRead) break;
		state.size += bytesRead;
		const bytes = state.tail.length
			? Buffer.concat([state.tail, chunk.subarray(0, bytesRead)])
			: chunk.subarray(0, bytesRead);
		// A newline byte never sits inside a multi-byte character.
		const end = bytes.lastIndexOf(0x0a);
		state.tail = Buffer.from(bytes.subarray(end + 1));
		if (end >= 0) feedState(state, bytes.toString("utf8", 0, end));
	}
	// A last line written without its newline yet counts once it's whole JSON,
	// as a read of the whole file counts it.
	if (state.tail.length) {
		const line = state.tail.toString("utf8");
		try {
			JSON.parse(line);
			state.tail = Buffer.alloc(0);
			feedState(state, line);
		} catch {}
	}
	const from = Math.max(0, state.size - SEAM_BYTES);
	state.seam = Buffer.alloc(state.size - from);
	await file.read(state.seam, 0, state.seam.length, from);
	if (state.head.length < HEAD_BYTES) {
		state.head = Buffer.alloc(Math.min(HEAD_BYTES, state.size));
		await file.read(state.head, 0, state.head.length, 0);
	}
}

/** `state` brought up to the file on disk, or read afresh when it was rewritten. */
async function readState(
	path: string,
	withImages: boolean,
	state: TranscriptState | undefined,
): Promise<TranscriptState> {
	const file = await open(path, "r");
	try {
		const { ino, size, mtimeMs } = await file.stat();
		if (
			state &&
			state.ino === ino &&
			state.size === size &&
			state.mtimeMs === mtimeMs
		)
			return state;
		let kept = Boolean(
			state &&
				state.ino === ino &&
				size >= state.size &&
				mtimeMs >= state.mtimeMs,
		);
		if (state && kept) {
			const head = Buffer.alloc(state.head.length);
			await file.read(head, 0, head.length, 0);
			const seam = Buffer.alloc(state.seam.length);
			await file.read(seam, 0, seam.length, state.size - seam.length);
			kept = head.equals(state.head) && seam.equals(state.seam);
		}
		const next =
			state && kept
				? state
				: freshState(ino, await realpath(path).catch(() => path), withImages);
		await readOn(file, next, size);
		next.mtimeMs = mtimeMs;
		next.result = null;
		return next;
	} finally {
		await file.close();
	}
}

function resultOf(
	state: TranscriptState,
): Omit<ParsedTranscript, "local" | "loop"> {
	const { cwd, aiTitle, prompt } = state.digest.result();
	const tail = state.tail.length ? state.tail.toString("utf8") : undefined;
	return {
		path: state.path,
		messages: state.messages.slice(-TAIL_MESSAGES),
		links: state.links.slice(),
		cwd,
		title: aiTitle,
		prompt,
		rules: state.rules.result(),
		usage: state.usage.result(tail),
		credential: state.credential.result(),
		mcpSignedOut: state.mcp.result(),
		slackDrafts: draftPlaces(state.drafts.calls),
		openPrompt: state.pending.result() !== null,
	};
}

/** Characters a kept read holds in its messages and links, roughly its size. */
function heldChars(state: TranscriptState): number {
	let chars = state.linkChars;
	for (const message of state.messages) {
		chars += message.text.length;
		for (const image of message.images ?? []) chars += image.length;
	}
	return chars;
}

/**
 * The reads kept, least recently used first: a parked session's poll is a
 * stat, a live one's reads only its new lines. Bounded by count and by the
 * text they hold, so a few huge sessions can't keep hundreds of MB.
 */
const parsedTranscripts = new Map<string, TranscriptState>();
const PARSED_TRANSCRIPTS_MAX = 64;
const PARSED_TRANSCRIPTS_CHARS = 32_000_000;
/** The read under way per file: two polls at once mustn't feed one state twice. */
const transcriptReads = new Map<string, Promise<TranscriptState>>();

async function keptState(
	key: string,
	path: string,
	withImages: boolean,
): Promise<TranscriptState> {
	const kept = parsedTranscripts.get(key);
	let state: TranscriptState;
	try {
		state = await readState(path, withImages, kept);
	} catch (error) {
		parsedTranscripts.delete(key);
		throw error;
	}
	// Re-insert so the map's order stays least-recently-used first.
	parsedTranscripts.delete(key);
	parsedTranscripts.set(key, state);
	let chars = 0;
	for (const each of parsedTranscripts.values()) chars += heldChars(each);
	for (const [oldest, each] of parsedTranscripts) {
		if (
			oldest === key ||
			(parsedTranscripts.size <= PARSED_TRANSCRIPTS_MAX &&
				chars <= PARSED_TRANSCRIPTS_CHARS)
		)
			break;
		chars -= heldChars(each);
		parsedTranscripts.delete(oldest);
	}
	return state;
}

export async function readTranscript({
	project,
	sessionId,
	root = projectsRoot(),
	withImages = false,
}: {
	/** Omit to locate the session by id across every project. */
	project?: string;
	sessionId: string;
	root?: string;
	/** Pasted images on the user's messages (see TranscriptMessage.images). */
	withImages?: boolean;
}): Promise<{
	path: string;
	messages: TranscriptMessage[];
	/** Every URL-quoting turn of the whole session - see `transcriptLinks`. */
	links: TranscriptMessage[];
	cwd: string | null;
	/**
	 * It ran on this computer. False for a remote host's session, whose
	 * transcript is mirrored here under the host's paths.
	 */
	local: boolean;
	/** Claude's own generated title for the conversation, when it has one. */
	title: string | null;
	/** The real opening prompt - `messages` is only the tail of a long session. */
	prompt: string | null;
	/** A `/loop` (or any schedule) still armed in this conversation. */
	loop: ActiveLoop | null;
	/** Odin rules that fired in this session, and on which PRs. */
	rules: RuleFiring[];
	/** Tokens, context and cost so far; null before the first reply. */
	usage: SessionUsage | null;
	/** The Claude plan or an API key, per the latest request; null before it. */
	credential: SessionCredential | null;
	/** The latest connector that lost its sign-in - see `mcp-sign-in`. */
	mcpSignedOut: McpSignedOut | null;
	/** Where the session left Slack drafts - see `slackDrafts`. */
	slackDrafts: string[];
	/**
	 * A question or plan is on screen, unanswered - see `pendingPrompt`. The
	 * Stop hook reports open action items as a prompt too; this tells them apart.
	 */
	openPrompt: boolean;
}> {
	if (!isSafeSegment(sessionId) || (project && !isSafeSegment(project))) {
		throw new Error("Invalid transcript reference");
	}
	const dir = project ?? (await projectOf(sessionId, root));
	if (!dir) throw new Error("No transcript on this machine for that session");
	const file = join(root, dir, `${sessionId}.jsonl`);
	const key = `${file}\0${withImages}`;
	const before = transcriptReads.get(key);
	const read = (async () => {
		await before?.catch(() => {});
		return keptState(key, file, withImages);
	})();
	transcriptReads.set(key, read);
	let state: TranscriptState;
	try {
		state = await read;
	} finally {
		if (transcriptReads.get(key) === read) transcriptReads.delete(key);
	}
	state.result ??= resultOf(state);
	const { cwd } = state.result;
	return {
		...state.result,
		loop: state.loop.result(Date.now()),
		// Where it started, or where its last turn ran: a session moved here
		// with Run on this computer keeps the host's cwd on its opening rows,
		// and judged by those alone, Resume sent it back to the host, where
		// Claude picked up the host's copy without anything it had done here
		// since. The start still counts, so a session that ended in a folder
		// since deleted (a temp dir) isn't read as the host's.
		local: ranHere(cwd) || ranHere(state.lastRan),
	};
}

/**
 * Whether a session's cwd is on this computer. Under the home folder counts
 * even when it's gone: the pruner removes a worktree and Resume brings it back.
 */
export function ranHere(cwd: string | null): boolean {
	return !cwd || cwd.startsWith(`${homedir()}/`) || existsSync(cwd);
}

/**
 * The Slack conversations this session drafted a reply into, as
 * "<channel>:<ts>" - the thread it replied in, or for a draft outside a
 * thread the moment it was written, so "a reply" is whatever comes after it.
 * Those are the places you wait on an answer once you send the draft.
 */
export function slackDrafts(jsonl: string): string[] {
	return draftPlaces(slackDraftCalls(jsonl));
}

function draftPlaces(calls: SlackDraftCall[]): string[] {
	return [
		...new Set(
			calls.map(
				({ channel, thread, at }) =>
					`${channel}:${thread ?? (at / 1000).toFixed(6)}`,
			),
		),
	];
}

type SlackDraftCall = {
	channel: string;
	thread: string | null;
	at: number;
	text: string;
};

/** Each Slack draft the session wrote: where, when (ms) and what it said. */
export function slackDraftCalls(jsonl: string): SlackDraftCall[] {
	const reader = slackDraftsReader();
	feedLines(jsonl, reader);
	return reader.calls;
}

/** slackDraftCalls, a line at a time - see LineReader. */
function slackDraftsReader(): LineReader & { calls: SlackDraftCall[] } {
	const calls: SlackDraftCall[] = [];
	return {
		calls,
		line(line, parse) {
			if (!line.includes("slack_send_message_draft")) return;
			const entry = parse() as
				| {
						isSidechain?: boolean;
						timestamp?: string;
						message?: { content?: unknown };
				  }
				| undefined;
			if (entry === undefined) return;
			const content = entry.message?.content;
			if (entry.isSidechain || !Array.isArray(content)) return;
			for (const block of content) {
				if (
					block?.type !== "tool_use" ||
					!String(block.name).endsWith("slack_send_message_draft")
				)
					continue;
				const channel = String(block.input?.channel_id ?? "");
				const thread = String(block.input?.thread_ts ?? "");
				const at = Date.parse(entry.timestamp ?? "");
				const inThread = /^\d+\.\d+$/.test(thread);
				if (/^[A-Z0-9]+$/.test(channel) && (inThread || Number.isFinite(at)))
					calls.push({
						channel,
						thread: inThread ? thread : null,
						at,
						text: String(block.input?.message ?? ""),
					});
			}
		},
	};
}

/** A question or plan Claude waits on: a menu only its terminal draws. */
export type PendingPrompt = {
	id: string;
	name: "AskUserQuestion" | "ExitPlanMode";
	input: Record<string, unknown>;
};

/**
 * The AskUserQuestion or ExitPlanMode call Claude waits on: the log's last
 * tool call, when it is one of those and has no result yet. As the board's
 * chat reads it (asking() in ChatView).
 */
export function pendingPrompt(jsonl: string): PendingPrompt | null {
	const reader = pendingPromptReader();
	feedLines(jsonl, reader);
	return reader.result();
}

/** pendingPrompt, a line at a time - see LineReader. */
function pendingPromptReader(): LineReader & {
	result(): PendingPrompt | null;
} {
	let last: PendingPrompt | { id: string; name: string } | null = null;
	const answered = new Set<string>();
	return {
		line(line, parse) {
			if (!line.includes("tool_")) return;
			const entry = parse() as
				| { isSidechain?: boolean; message?: { content?: unknown } }
				| undefined;
			if (entry === undefined) return;
			if (entry.isSidechain || !Array.isArray(entry.message?.content)) return;
			for (const block of entry.message.content as {
				type?: string;
				id?: string;
				name?: string;
				input?: unknown;
				tool_use_id?: string;
			}[]) {
				if (block?.type === "tool_use" && block.id && block.name)
					last =
						(block.name === "AskUserQuestion" ||
							block.name === "ExitPlanMode") &&
						block.input &&
						typeof block.input === "object"
							? {
									id: block.id,
									name: block.name,
									input: block.input as Record<string, unknown>,
								}
							: { id: block.id, name: block.name };
				else if (block?.type === "tool_result" && block.tool_use_id)
					answered.add(block.tool_use_id);
			}
		},
		result: () =>
			last && "input" in last && !answered.has(last.id) ? last : null,
	};
}

/** One tool call of the turn under way, in words. */
export type TurnStep = {
	id: string;
	text: string;
	done: boolean;
	error: boolean;
};

/** The turn under way: since your last message, what Claude ran. */
export type Turn = {
	/** When your message landed. */
	start: string | null;
	/** Output tokens Claude wrote this turn. */
	tokens: number;
	/** The latest steps, oldest first. */
	steps: TurnStep[];
	/** How many steps the turn has, shown or not. */
	total: number;
};

const TURN_STEPS = 40;

/**
 * The turn under way, as the board's chat shows it while Claude works
 * (currentTurn in ChatView): it begins at your last message - typed, or
 * queued by a human - and holds every tool call since, named the board's way.
 */
export function turnSteps(jsonl: string): Turn | null {
	let turn: {
		start: string | null;
		steps: TurnStep[];
		out: Map<string, number>;
	} | null = null;
	const byId = new Map<string, TurnStep>();
	for (const line of jsonl.split("\n")) {
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.isSidechain) continue;
		const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
		const queued = entry.attachment as
			| { type?: string; prompt?: unknown; origin?: { kind?: string } }
			| undefined;
		if (entry.type === "attachment" && queued?.type === "queued_command") {
			const human = !queued.origin?.kind || queued.origin.kind === "human";
			if (human && spokenText(messageText(queued.prompt).trim()))
				turn = { start: at, steps: [], out: new Map() };
			continue;
		}
		const message = entry.message as
			| { id?: string; content?: unknown; usage?: { output_tokens?: number } }
			| undefined;
		if (entry.type === "user") {
			const raw = messageText(message?.content).trim();
			if (raw && isTypedByUser(entry, raw) && spokenText(raw)) {
				turn = { start: at, steps: [], out: new Map() };
				continue;
			}
			if (!Array.isArray(message?.content)) continue;
			for (const block of message.content as {
				type?: string;
				tool_use_id?: string;
				is_error?: boolean;
			}[]) {
				const step =
					block?.type === "tool_result" && block.tool_use_id
						? byId.get(block.tool_use_id)
						: undefined;
				if (step) {
					step.done = true;
					step.error = !!block.is_error;
				}
			}
			continue;
		}
		if (entry.type !== "assistant" || !turn) continue;
		if (message?.id && message.usage?.output_tokens)
			turn.out.set(
				message.id,
				Math.max(turn.out.get(message.id) ?? 0, message.usage.output_tokens),
			);
		if (!Array.isArray(message?.content)) continue;
		for (const block of message.content as {
			type?: string;
			id?: string;
			name?: string;
			input?: unknown;
		}[]) {
			if (block?.type !== "tool_use" || !block.id || !block.name) continue;
			const step = {
				id: block.id,
				text: toolDescription({
					name: block.name,
					input:
						block.input && typeof block.input === "object"
							? (block.input as Record<string, unknown>)
							: {},
				}),
				done: false,
				error: false,
			};
			byId.set(step.id, step);
			turn.steps.push(step);
		}
	}
	if (!turn) return null;
	let tokens = 0;
	for (const out of turn.out.values()) tokens += out;
	return {
		start: turn.start,
		tokens,
		steps: turn.steps.slice(-TURN_STEPS),
		total: turn.steps.length,
	};
}

/** The last messages, from the file's end only: what the phone polls. */
const tails = new Map<
	string,
	{
		key: string;
		messages: TranscriptMessage[];
		prompt: PendingPrompt | null;
		turn: Turn | null;
	}
>();

/** The prompt `transcriptTail` last found in that session's log. */
export const tailPrompt = (sessionId: string) =>
	tails.get(sessionId)?.prompt ?? null;

/** The turn `transcriptTail` last found in that session's log. */
export const tailTurn = (sessionId: string) =>
	tails.get(sessionId)?.turn ?? null;
export async function transcriptTail({
	sessionId,
	bytes = 8_000_000,
	root = projectsRoot(),
}: {
	sessionId: string;
	bytes?: number;
	root?: string;
}): Promise<TranscriptMessage[]> {
	if (!isSafeSegment(sessionId))
		throw new Error("Invalid transcript reference");
	const dir = await projectOf(sessionId, root);
	if (!dir) throw new Error("No transcript on this machine for that session");
	const file = join(root, dir, `${sessionId}.jsonl`);
	const { size, mtimeMs } = await stat(file);
	// A session's log only grows: same size and time, same messages.
	const key = `${size}:${mtimeMs}`;
	const hit = tails.get(sessionId);
	if (hit?.key === key) return hit.messages;
	const start = Math.max(0, size - bytes);
	const handle = await open(file, "r");
	const buffer = Buffer.alloc(size - start);
	try {
		await handle.read(buffer, 0, buffer.length, start);
	} finally {
		await handle.close();
	}
	let text = buffer.toString("utf-8");
	// Cut in the middle of a line: start at the next whole one.
	if (start > 0) text = text.slice(text.indexOf("\n") + 1);
	// The phone shows a reply whole: the cut is only against a runaway one.
	const messages = parseTranscript(text, 60, 100_000, true, true);
	tails.set(sessionId, {
		key,
		messages,
		prompt: pendingPrompt(text),
		turn: turnSteps(text),
	});
	return messages;
}

export interface RuleFiring {
	/** The rule as the agent read it - "When …: …". */
	rule: string;
	/** PR urls it fired on, oldest first. */
	on: string[];
}

/**
 * A command that really opens or pushes to a PR - at the start of a line or
 * after `&&`/`;`/`|`, past any `VAR=value` prefix; git may carry options
 * before `push`. The hook itself greps the whole payload, so it also fires on
 * a `cat` of a file that merely mentions `git push`; those aren't the rule
 * being applied.
 */
const PR_ACTION =
	/(?:^|[;&|])\s*(?:(?:\w+=\S*|command|env|builtin|exec|nohup|time)\s+)*(?:gh pr (?:create|edit|ready)|git\b[^;&|\n]*?\spush)\b/m;
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/**
 * A Bash command that opens a PR: `gh pr create`, or a POST to the REST
 * `pulls` endpoint itself (the fallback when GraphQL is rate-limited) - not a
 * comment or review on one, `pulls/<n>/...`. A `curl` POST to that endpoint
 * counts too: a host with no gh sign-in for the repo opens it with a shared
 * key that way, and the PR's author is then that key's bot. Only in command
 * position: a `grep "gh pr create"` prints PR urls that are not this
 * session's. Env assignments and wrappers like `command gh` (past a gh
 * alias) still count.
 */
const GH_COMMAND =
	/(?:^|[;&|(])\s*(?:(?:\w+=(?:\$\([^)]*\)|\S*)|command|env|builtin|exec|nohup|time)\s+)*(gh (?:pr create\b|api\b)|curl\b)([^;&|\n]*)/gm;
export function opensPr(command: string): boolean {
	for (const [, tool = "", args = ""] of command.matchAll(GH_COMMAND)) {
		if (tool.startsWith("gh pr create")) return true;
		const posts = /(?:-X|--method|--request)[\s=]*POST\b/i.test(args);
		if (tool === "gh api" && posts && /\/pulls(?![/\w])/.test(args))
			return true;
		if (
			tool === "curl" &&
			posts &&
			/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/pulls(?![/\w])/.test(args)
		)
			return true;
	}
	return false;
}

/**
 * The branches a shell command pushes: `git push origin fix/x`,
 * `git push -u origin HEAD:fix/x`, `git -c a=b push <url> x:x`. The remote
 * side of each refspec, without `refs/heads/`. A bare `git push` names none.
 */
export function pushedBranches(command: string): string[] {
	const found: string[] = [];
	for (const part of command.split(/&&|\|\||[;|\n]/)) {
		const words = part.trim().split(/\s+/);
		const git = words.findIndex((w) => w === "git" || w.endsWith("/git"));
		if (git < 0) continue;
		const push = words.indexOf("push", git + 1);
		if (push < 0) continue;
		// Options before `push` (`-c key=value`, `-C dir`) take a value.
		const before = words.slice(git + 1, push);
		if (
			before.some(
				(w, i) => !w.startsWith("-") && !/^-[cC]$/.test(before[i - 1] ?? ""),
			)
		)
			continue;
		const args = words
			.slice(push + 1)
			.filter((w) => !w.startsWith("-") && !/^[0-9]*[<>]/.test(w));
		for (const spec of args.slice(1)) {
			const dst = (spec.split(":").pop() ?? "")
				.replace(/^\+/, "")
				.replace(/^refs\/heads\//, "")
				.replace(/^["']|["']$/g, "");
			if (dst && dst !== "HEAD" && /^[\w./-]+$/.test(dst)) found.push(dst);
		}
	}
	return found;
}

/** A rule line's repo pin, as `ruleLine` writes it. */
const RULE_SCOPE = / \((only|except) in the repos? at ([^)]+)\):/;

/**
 * Whether a repo-pinned rule covers this PR. A feed session's checkout isn't
 * known at launch, so the hook hands it every pinned rule and the agent skips
 * the ones for other repos - those didn't fire.
 */
function coversPr(rule: string, pr: string): boolean {
	const scope = rule.match(RULE_SCOPE);
	if (!scope) return true;
	const repo = pr.split("/")[4];
	const pinned = (scope[2] ?? "")
		.split(", ")
		.some((path) => path.replace(/\/+$/, "").split("/").pop() === repo);
	return pinned === (scope[1] === "only");
}

/**
 * The PR-rule hook's firings, each pinned to the PR it fired on: the PR url
 * in that Bash call's output (`gh pr create` prints it), else the session's
 * latest PR so far - a later `git push` prints only the branch.
 */
export function ruleFirings(jsonl: string): RuleFiring[] {
	const reader = ruleFiringsReader();
	feedLines(jsonl, reader);
	return reader.result();
}

/**
 * ruleFirings, a line at a time - see LineReader. It keeps only what the
 * answer reads: which Bash calls change a PR, and the PR urls in outputs.
 */
function ruleFiringsReader(): LineReader & { result(): RuleFiring[] } {
	const prActions = new Set<string>();
	const outputPrs = new Map<string, string[]>();
	const fired: { rules: string[]; toolUseId: string }[] = [];
	return {
		line(line, parse) {
			if (
				!line.includes('"tool_use') &&
				!line.includes(PR_RULES_HEADER.slice(0, 40))
			)
				return;
			const entry = parse() as
				| {
						isSidechain?: boolean;
						message?: { content?: unknown };
						attachment?: {
							type?: string;
							content?: unknown;
							toolUseID?: string;
						};
				  }
				| undefined;
			if (entry === undefined) return;
			if (entry.isSidechain) return;
			const hook = entry.attachment;
			if (hook?.type === "hook_additional_context" && hook.toolUseID) {
				const text = ([] as unknown[]).concat(hook.content).join("\n");
				if (!text.includes(PR_RULES_HEADER)) return;
				const rules = text
					.split(PR_RULES_HEADER)[1]
					.split("\n")
					.filter((l) => l.startsWith("- "))
					.map((l) => l.slice(2).trim());
				fired.push({ rules, toolUseId: hook.toolUseID });
				return;
			}
			const content = entry.message?.content;
			if (!Array.isArray(content)) return;
			for (const block of content) {
				if (block?.type === "tool_use" && block.name === "Bash") {
					if (PR_ACTION.test(String(block.input?.command ?? "")))
						prActions.add(block.id);
					else prActions.delete(block.id);
				} else if (block?.type === "tool_result") {
					const prs = messageText(block.content).match(PR_URL);
					if (prs) outputPrs.set(block.tool_use_id, prs);
					else outputPrs.delete(block.tool_use_id);
				}
			}
		},
		result() {
			const byRule = new Map<string, string[]>();
			let lastPr: string | null = null;
			for (const { rules, toolUseId } of fired) {
				if (!prActions.has(toolUseId)) continue;
				const prs = outputPrs.get(toolUseId) ?? [];
				if (prs.length) lastPr = prs[prs.length - 1] ?? null;
				const on = prs.length ? prs : lastPr ? [lastPr] : [];
				if (!on.length) continue;
				for (const rule of rules) {
					const list = byRule.get(rule) ?? [];
					for (const pr of on)
						if (coversPr(rule, pr) && !list.includes(pr)) list.push(pr);
					if (list.length) byRule.set(rule, list);
				}
			}
			return [...byRule].map(([rule, on]) => ({ rule, on }));
		},
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
 * wasn't a `stop`. Both only live inside the running claude process - the
 * caller has to check the session is still up.
 */
export function activeLoop(
	jsonl: string,
	now: number = Date.now(),
): ActiveLoop | null {
	const reader = loopReader();
	feedLines(jsonl, reader);
	return reader.result(now);
}

/**
 * activeLoop, a line at a time - see LineReader. Whether a cron has expired
 * depends on the time asked, so it keeps the schedule calls in order and
 * replays them against `now`.
 */
function loopReader(): LineReader & { result(now: number): ActiveLoop | null } {
	const cronCalls: (
		| { at: number; recurring: boolean; loop: ActiveLoop }
		| "delete"
	)[] = [];
	let wakeup: { at: number; loop: ActiveLoop } | null = null;
	return {
		line(line, parse) {
			if (!line.includes('"tool_use"')) return;
			const entry = parse() as
				| { timestamp?: unknown; message?: { content?: unknown } }
				| undefined;
			if (entry === undefined) return;
			const at = Date.parse(String(entry.timestamp));
			const content = entry.message?.content;
			if (!Array.isArray(content) || Number.isNaN(at)) return;
			for (const block of content) {
				if (block?.type !== "tool_use") continue;
				const input = (block.input ?? {}) as Record<string, unknown>;
				const prompt = typeof input.prompt === "string" ? input.prompt : null;
				if (block.name === "CronCreate") {
					cronCalls.push({
						at,
						recurring: input.recurring !== false,
						loop: { kind: "cron", schedule: String(input.cron), prompt },
					});
				} else if (block.name === "CronDelete") {
					cronCalls.push("delete");
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
		},
		result(now) {
			const crons: ActiveLoop[] = [];
			for (const call of cronCalls) {
				if (call === "delete") crons.shift();
				else if (call.recurring && now - call.at <= CRON_LIFETIME_MS)
					crons.push(call.loop);
			}
			if (crons.length) return crons[crons.length - 1] as ActiveLoop;
			return wakeup && now < wakeup.at + WAKEUP_GRACE_MS ? wakeup.loop : null;
		},
	};
}

const loopCache = new Map<
	string,
	{ mtimeMs: number; checkedAt: number; loop: ActiveLoop | null }
>();
/** A cron loop can expire with its transcript untouched, so a cached answer is re-read after this. */
const LOOP_RECHECK_MS = 60 * 60_000;

/**
 * `activeLoop` for a session found by id. An ended session's transcript stops
 * changing, so the file is read again only when it did, or after an hour.
 */
export async function sessionLoop(
	sessionId: string,
	root: string = projectsRoot(),
	now: number = Date.now(),
): Promise<ActiveLoop | null> {
	const file = await transcriptOf(sessionId, root);
	if (!file) return null;
	const cached = loopCache.get(file.path);
	if (
		cached?.mtimeMs === file.mtimeMs &&
		now - cached.checkedAt < LOOP_RECHECK_MS
	)
		return cached.loop;
	const loop = activeLoop(await readFile(file.path, "utf-8"), now);
	loopCache.set(file.path, { mtimeMs: file.mtimeMs, checkedAt: now, loop });
	return loop;
}

/** The checkout containing `dir`, or null outside a repo. */
function repoRootOf(dir: string): string | null {
	let current = dir;
	while (true) {
		// A worktree's `.git` is a file, a clone's is a directory - either is a root.
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * The repo a checkout belongs to - itself for a clone, the owning clone for a
 * worktree. A worktree's `.git` is a file pointing at
 * `<repo>/.git/worktrees/<name>`, so its owner is one read away.
 *
 * Both callers need this. The label needs it because a worktree is named after
 * the branch it holds, and a card reading `review-6460` says nothing about
 * where the work landed. The tally needs it because a session that splits its
 * time between a repo and a worktree of that same repo is working in ONE repo,
 * and counting them separately splits the vote - that is how a session with
 * 259 entries in web-server came out labelled `dev`.
 */
export function ownerRepoOf(checkout: string): string {
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
		// Unreadable .git - the checkout is its own best answer.
	}
	return checkout;
}

/**
 * The repo a directory sits in, by name - or null when it isn't in one. A
 * folder's own basename is not a repo name: a plain `~/Documents/Dan Wedding`
 * or a scratchpad would otherwise pass for one. A deleted worktree still
 * resolves, since its path walks up into the clone that held it.
 */
export function repoOfDir(dir: string): string | null {
	const root = repoRootOf(dir);
	return root && !holdsClones(root) ? repoNameOf(root) : null;
}

const containers = new Map<string, boolean>();

/**
 * Whether a repo is a folder of other clones - `~/dev`, a repo of loose
 * scripts that also contains every checkout. Work run from there is general,
 * not work on it. Looks two levels down (`~/dev/acme/<clone>`), skipping
 * dot-folders so a repo's own `.worktrees` don't count against it.
 */
function holdsClones(root: string): boolean {
	const hit = containers.get(root);
	if (hit !== undefined) return hit;
	const children = (dir: string) => {
		try {
			return readdirSync(dir, { withFileTypes: true })
				.filter(
					(entry) =>
						entry.isDirectory() &&
						!entry.name.startsWith(".") &&
						entry.name !== "node_modules",
				)
				.map((entry) => join(dir, entry.name));
		} catch {
			return [];
		}
	};
	const found = children(root).some(
		(child) =>
			existsSync(join(child, ".git")) ||
			children(child).some((grand) => existsSync(join(grand, ".git"))),
	);
	containers.set(root, found);
	return found;
}

/** What to call a checkout on a card: the repo's name, never the worktree's. */
export function repoNameOf(checkout: string): string {
	return basename(ownerRepoOf(checkout));
}

/**
 * The checkout a session did its work in.
 *
 * Claude Code stamps a cwd on every transcript entry, and that cwd is the
 * working directory of each individual tool call - so it hops between repos,
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
 */
export async function workingRepoOf(
	sessionId: string,
	root: string = projectsRoot(),
	checkouts: CheckoutResolver = localCheckouts,
): Promise<string | null> {
	const tallied = await tallyCheckouts(sessionId, root, checkouts);
	if (!tallied) return null;
	// The repo is decided; hand back the checkout inside it the session used
	// most, since that is the tree with the changes in it.
	let best: string | null = null;
	let bestTally: Tally = { count: 0, lastSeen: 0 };
	for (const [checkout, tally] of tallied.perCheckout) {
		if (
			checkouts.ownerOf(checkout) === tallied.winner &&
			busiest(tally, bestTally)
		) {
			best = checkout;
			bestTally = tally;
		}
	}
	return best;
}

/**
 * The worktree a session last worked in, inside the repo `workingRepoOf`
 * picked - or null when it never left the clone. An agent typically runs a
 * dozen commands in the clone before cutting its worktree, so "busiest" lands
 * on the clone; the place to go to pick the work up is the worktree.
 */
export async function workingWorktreeOf(
	sessionId: string,
	root: string = projectsRoot(),
	checkouts: CheckoutResolver = localCheckouts,
): Promise<string | null> {
	const tallied = await tallyCheckouts(sessionId, root, checkouts);
	if (!tallied) return null;
	let best: string | null = null;
	let lastSeen = 0;
	for (const [checkout, tally] of tallied.perCheckout) {
		if (
			checkout !== tallied.winner &&
			checkouts.ownerOf(checkout) === tallied.winner &&
			tally.lastSeen > lastSeen
		) {
			best = checkout;
			lastSeen = tally.lastSeen;
		}
	}
	return best;
}

interface Tally {
	count: number;
	lastSeen: number;
}
const busiest = (a: Tally, b: Tally) =>
	a.count > b.count || (a.count === b.count && a.lastSeen > b.lastSeen);

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** The absolute paths an assistant message's file-editing tool calls wrote to. */
function editedFilesOf(message: unknown): string[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	const files: string[] = [];
	for (const block of content as {
		type?: string;
		name?: string;
		input?: { file_path?: unknown; notebook_path?: unknown };
	}[]) {
		if (block?.type !== "tool_use" || !EDIT_TOOLS.has(block.name ?? ""))
			continue;
		const path = block.input?.file_path ?? block.input?.notebook_path;
		if (typeof path === "string" && path.startsWith("/")) files.push(path);
	}
	return files;
}

/**
 * How a folder maps to its checkout and a checkout to its repo. This
 * computer's disk by default; a remote host's session passes the host's
 * answers, since its transcript's folders are paths on the host.
 */
export interface CheckoutResolver {
	/** The checkout holding `dir`, or null outside one. */
	rootOf(dir: string): string | null;
	/** The repo owning a checkout: itself for a clone, the clone for a worktree. */
	ownerOf(checkout: string): string;
}

const localCheckouts: CheckoutResolver = {
	rootOf: repoRootOf,
	ownerOf: ownerRepoOf,
};

/** Each transcript line's folders: its cwd first, then the folders of the files it edited. */
function votingDirs(text: string): { dirs: string[]; index: number }[] {
	const votes: { dirs: string[]; index: number }[] = [];
	let index = 0;
	for (const line of text.split("\n")) {
		index += 1;
		let entry: { cwd?: unknown; message?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // blank line, or a truncated write mid-line
		}
		// The folder of each file the entry edited votes beside its cwd. A `cd`
		// that ends outside the session's working directories snaps back to the
		// start folder, so a worktree cut beside the clone (`~/dev/dbt-fix` next
		// to `~/dev/dbt`) never shows up as a cwd - only its edits name it.
		const dirs = editedFilesOf(entry.message).map(dirname);
		if (typeof entry.cwd === "string" && entry.cwd) dirs.unshift(entry.cwd);
		if (dirs.length) votes.push({ dirs, index });
	}
	return votes;
}

/** Every folder a transcript ran commands in or edited files in, each once. */
export function transcriptDirs(text: string): string[] {
	return [...new Set(votingDirs(text).flatMap((vote) => vote.dirs))];
}

/** Every checkout the transcript ran commands in or edited, and the repo that won. */
async function tallyCheckouts(
	sessionId: string,
	root: string,
	checkouts: CheckoutResolver = localCheckouts,
): Promise<{ winner: string; perCheckout: Map<string, Tally> } | null> {
	const found = await transcriptOf(sessionId, root);
	if (!found) return null;

	const perCheckout = new Map<string, Tally>();
	const checkoutOfDir = new Map<string, string | null>();
	for (const { dirs, index } of votingDirs(
		await readFile(found.path, "utf-8"),
	)) {
		for (const dir of dirs) {
			if (!checkoutOfDir.has(dir))
				checkoutOfDir.set(dir, checkouts.rootOf(dir));
			const checkout = checkoutOfDir.get(dir);
			if (!checkout) continue;

			const tally = perCheckout.get(checkout);
			if (tally) {
				tally.count += 1;
				tally.lastSeen = index;
			} else {
				perCheckout.set(checkout, { count: 1, lastSeen: index });
			}
		}
	}

	const perRepo = new Map<string, Tally>();
	for (const [checkout, tally] of perCheckout) {
		const repo = checkouts.ownerOf(checkout);
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
	// clone, so every tool call that never cd'd anywhere votes for it - enough
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
	return winner ? { winner, perCheckout } : null;
}

/**
 * What a session was about, in one line.
 *
 * `cleanPrompt` keeps the whole Slack preamble on purpose - Session History
 * searches it - but a one-line label has room for the ask and nothing else. So
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
 * the first few entries, and the alternative - parsing whole transcripts for a
 * string that lives in line three - is what makes a whole-store scan expensive.
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
		const raw = messageText(message?.content).trim();
		const command = slashCommand(raw);
		const text = command ?? raw;
		if (!text || (!command && !isTypedByUser(entry, text))) continue;
		return titleFromPrompt(cleanPrompt(text)) || null;
	}
	return null;
}
