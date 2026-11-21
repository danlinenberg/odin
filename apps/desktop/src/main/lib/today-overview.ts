import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	summarizeTranscript,
	transcriptOf,
} from "./claude-sessions/claude-sessions";
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
	/** The task it was started from, as "Source: title" (a Jira ticket, a Slack thread...). */
	from?: string | null;
}

/** One task: the sessions that serve it, in plain words. */
export interface TodayTask {
	/** The sessions' keys, in the order the model named them. */
	keys: string[];
	/** A short name for the task. */
	name: string;
	/** What the task is, in one short sentence. */
	about: string | null;
	/** The task explained for someone who never saw it: background, what changes once done, why now. */
	explain: string | null;
	/** Where it stands now. */
	line: string | null;
	/** What is left before it is done. */
	left: string | null;
	/** Who acts next and what they do. */
	next: string | null;
}

export interface TodayLines {
	/** One sentence over the whole list. Null when the model gave none. */
	summary: string | null;
	/** The sessions grouped into tasks. A session the model skipped is in none. */
	tasks: TodayTask[];
}

const INSTRUCTIONS = `You write a morning overview of someone's open work, in plain language, for a busy person reading it over coffee who may not remember the details.
Each numbered line below is one work session, listed in the order to do them: number | board state (Needs you, Almost done, Running, ...) | due | priority | waiting on | started from | title | opening request (what the person first asked, in their words) | goal | what was done so far | status | next step.
Several sessions often serve the same task (the same feature, bug, request or investigation): put those in one task.
Reply with ONLY these lines, no markdown, no preamble:
SUMMARY: <one or two short sentences starting with a verb, like a colleague telling them where to start. Start with the task holding the lowest-numbered session whose next step is theirs, and say why it comes first (a deadline, someone waiting, it unblocks other work, it takes a minute). Then the second only if it is urgent. Call each task exactly by its name from its TASK line.>
TASK <session numbers, comma separated>: <name> | <what it is> | <explanation> | <where it stands> | <what is left> | <next>
The six parts of a TASK line:
- name: 2 to 6 words, a noun phrase naming the thing ("Sign-in for new users", "CSV export"), not a verb. Never copy the session title or the opening request: if they read like an instruction ("fix the...", "can you..."), name the thing instead.
- what it is: one short sentence on the subject itself, not the work steps: what the thing is (the feature, screen, bug, report or question) and who it is for. Never just repeat the name.
- explanation: why it matters, in two or three plain sentences for someone who never saw this work: what goes wrong today and for whom (or what is missing), who asked for it or how it was found, and what changes once it is done. Do not repeat "what it is". Understand it from the opening request and the goal, but never quote them. Explain any technical idea in everyday words. Never describe the session itself ("Claude is working on", "this session").
- where it stands: what is already done, concretely ("the fix is written and the tests pass", "the export works for one team").
- what is left: the remaining steps before it is done, and roughly how much ("only a review and a merge", "about half: the email and its test").
- next: who acts next, then a verb and the exact thing, starting with "You:", "Claude:" or the person's name ("You: pick between the two email wordings", "You: merge the pull request", "Claude: is writing the test", "Alex: has to reply on the ticket"). When the board state is Needs you or Almost done, next starts with "You:" and names the exact question, approval or decision. Never just "You: review" or "You: check".
Every session number goes in exactly one TASK line. A session that shares nothing with the others is a task of its own.

Rules:
- Always answer in English.
- In the summary: no counts of sessions or tasks, no session numbers, and nothing about what is missing (no due dates, no details, no notes). Never pad a sentence with ", and none..." or ", and nothing...".
- No PR numbers, ticket keys, issue numbers, commit hashes, branch names, file paths or URLs. Say "the pull request" or "the ticket" instead.
- Say what the work is about in everyday words, not code names. Name the product area or the user it affects.
- Under 220 characters for the summary and for each part of a TASK line, except the explanation: under 400.`;

const clean = (text: string | null | undefined, cap: number) =>
	(text ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, cap) ||
	"-";

/** One task as the model reads it. */
export function todayLine(
	item: TodayItem,
	index: number,
	brief?: {
		goal?: string | null;
		done?: string | null;
		status?: string | null;
		next?: string | null;
	},
	ask?: string | null,
): string {
	return [
		index + 1,
		item.group,
		item.due ?? "-",
		item.priority ?? "-",
		clean(item.waitingOn, 80),
		clean(item.from, 160),
		clean(item.title, 120),
		clean(ask, 600),
		clean(brief?.goal, 240),
		clean(brief?.done, 300),
		clean(brief?.status, 200),
		clean(brief?.next, 200),
	].join(" | ");
}

/** The model's answer back into a summary and the tasks. */
export function parseTodayLines(text: string, keys: string[]): TodayLines {
	const tasks: TodayTask[] = [];
	const used = new Set<string>();
	let summary: string | null = null;
	let inSummary = false;
	for (const raw of text.split("\n")) {
		const row = raw
			.replace(/^[\s*-]+/, "")
			.replace(/\*\*/g, "")
			.trim();
		const said = /^summary\s*:\s*(.+)$/i.exec(row);
		if (said) {
			summary = said[1].trim() || null;
			inSummary = true;
			continue;
		}
		const task = /^task\s+([\d,\s]+?)\s*[:.)]\s*(.+)$/i.exec(row);
		if (!task) {
			// A summary the model wrapped onto the next lines reads on to the
			// first TASK line; a blank line ends it.
			if (inSummary && row && summary) summary = `${summary} ${row}`;
			else inSummary = false;
			continue;
		}
		inSummary = false;
		const mine = task[1]
			.split(/[,\s]+/)
			.map((n) => keys[Number(n) - 1])
			.filter((key): key is string => !!key && !used.has(key));
		const [name, about, explain, line, left, next] = task[2]
			.split("|")
			.map((part) => part.trim().replace(/^-$/, ""));
		if (!mine.length || !name) continue;
		for (const key of mine) used.add(key);
		tasks.push({
			keys: [...new Set(mine)],
			name,
			about: about || null,
			explain: explain || null,
			line: line || null,
			left: left || null,
			next: next || null,
		});
	}
	return { summary, tasks };
}

/** How much of a transcript's start is read for its opening request. */
const HEAD_BYTES = 64 * 1024;

/** The session's opening request, from the first lines of its transcript. */
export async function openingAsk(
	sessionId: string,
	root?: string,
): Promise<string | null> {
	const file = await transcriptOf(sessionId, root).catch(() => null);
	if (!file) return null;
	const handle = await open(file.path, "r").catch(() => null);
	if (!handle) return null;
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
		// A cut last line is skipped by the parser.
		return summarizeTranscript(buffer.toString("utf8", 0, bytesRead)).prompt;
	} catch {
		return null;
	} finally {
		await handle.close();
	}
}

/**
 * Each session's goal from its cached brief, by session id: what Today
 * says a task is about at once, before (or without) the written overview.
 */
export async function todayGoals(
	sessionIds: string[],
): Promise<Record<string, string>> {
	const briefs = await cachedBriefs().catch(() => new Map());
	const goals: Record<string, string> = {};
	for (const id of sessionIds) {
		const goal = briefs.get(id)?.goal?.trim();
		if (goal) goals[id] = goal;
	}
	return goals;
}

const cache = new Map<string, TodayLines>();
const inFlight = new Map<string, Promise<TodayLines>>();

export async function writeTodayLines(
	items: TodayItem[],
	{
		claudeBin = "claude",
		// A full board (30+ sessions) takes Haiku well over a minute.
		timeoutMs = 300_000,
		fresh = false,
	}: { claudeBin?: string; timeoutMs?: number; fresh?: boolean } = {},
): Promise<TodayLines> {
	if (!items.length) return { summary: null, tasks: [] };
	const briefs = await cachedBriefs().catch(() => new Map());
	const asks = await Promise.all(
		items.map((item) => (item.sessionId ? openingAsk(item.sessionId) : null)),
	);
	const body = items
		.map((item, i) =>
			todayLine(
				item,
				i,
				item.sessionId ? briefs.get(item.sessionId) : undefined,
				asks[i],
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
