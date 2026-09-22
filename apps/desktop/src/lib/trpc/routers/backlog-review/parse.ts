import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The backlog sweep's answer, on its way back into the app.
 *
 * The sweep runs as an ordinary agent session, so its findings live where
 * every session's findings live: in a terminal. That is fine to read and
 * useless to act on — clearing the backlog off it means re-reading a table and
 * deleting rows by hand. So the session also writes its verdicts to a file,
 * and the Review screen joins them back onto the live rows.
 *
 * A file, rather than the agent calling back into Odin: an agent in a terminal
 * has no route to the renderer, and writing one is a tool it already has.
 *
 * No electron in here, so the parser can be tested on its own (parse.test.ts).
 */

/** Where the sweep is told to write. One path, shared with the prompt. */
export const REVIEW_FILE = "backlog-review.json";

export function reviewPath(): string {
	return join(
		process.env.ODIN_HOME_DIR ?? join(homedir(), ".odin"),
		REVIEW_FILE,
	);
}

/** One line of the sweep's table, as the agent hands it back. */
export interface Verdict {
	/** The item's number in the prompt — how it joins back to the backlog. */
	n: number;
	verdict: "DROP" | "KEEP" | "UNKNOWN";
	/** What it read, quoted. The whole reason to trust a DROP. */
	evidence: string;
}

const VERDICTS = new Set(["DROP", "KEEP", "UNKNOWN"]);

/**
 * Parse what the agent wrote.
 *
 * Deliberately forgiving about shape and unforgiving about content: this is a
 * language model writing JSON, so it may wrap the array in an object or fence
 * it in a code block, and it must not be able to smuggle a fourth verdict or a
 * missing number past us into a list of things to delete. Anything that isn't
 * a clean row is dropped rather than guessed at.
 */
export function parseVerdicts(raw: string): Verdict[] {
	// A fenced block is the single most likely deviation — take what's inside.
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
	const text = (fenced?.[1] ?? raw).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const rows = Array.isArray(parsed)
		? parsed
		: // {verdicts: [...]} / {items: [...]} / {results: [...]}: one wrapper key
			// holding the array is the other thing that happens.
			Object.values(parsed ?? {}).find(Array.isArray);
	if (!Array.isArray(rows)) return [];
	const seen = new Set<number>();
	const verdicts: Verdict[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const { n, verdict, evidence } = row as Record<string, unknown>;
		const num = typeof n === "string" ? Number.parseInt(n, 10) : n;
		if (typeof num !== "number" || !Number.isInteger(num) || num < 1) continue;
		if (typeof verdict !== "string") continue;
		const upper = verdict.trim().toUpperCase();
		if (!VERDICTS.has(upper)) continue;
		// First answer wins. A second row for the same item is the agent
		// correcting itself mid-file or looping, and neither is worth guessing.
		if (seen.has(num)) continue;
		seen.add(num);
		verdicts.push({
			n: num,
			verdict: upper as Verdict["verdict"],
			evidence: typeof evidence === "string" ? evidence.trim() : "",
		});
	}
	return verdicts.sort((a, b) => a.n - b.n);
}
