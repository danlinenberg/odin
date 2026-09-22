import type { BacklogItem } from "../hooks/builtin-automations";

/**
 * The sweep's answers, lined up against the backlog as it stands now.
 *
 * The sweep runs inside Odin, so an answer arrives already attached to the row
 * it is about — nothing here has to work out which item a verdict meant. What
 * this does is the part that can't be done when the sweep runs: say which rows
 * have since left the backlog, and put what it wants gone at the top.
 */

/** One item as it was swept, with what the lookup found. */
export interface SweptRow {
	/** `task:<id>` / `slack:<channel>:<ts>` — the row to clear on DROP. */
	key: string;
	source: string;
	title: string;
	url?: string;
	verdict: "DROP" | "KEEP" | "UNKNOWN";
	/** The state that was actually read. The whole reason to trust a DROP. */
	evidence: string;
}

/** A swept row, ready to render and decide on. */
export interface ReviewRow extends SweptRow {
	/** Its place in the sweep, from 1 — so the screen reads as a list. */
	n: number;
	/** The row has since left the backlog — decided elsewhere, or already cleared. */
	stale: boolean;
}

const ORDER: Record<SweptRow["verdict"], number> = {
	DROP: 0,
	UNKNOWN: 1,
	KEEP: 2,
};

/**
 * The review list: DROPs first, then the ones it couldn't check, then what it
 * wants kept.
 *
 * `live` is the backlog as it stands right now. An item missing from it was
 * dealt with between the sweep and you looking at this, so its row is marked
 * rather than dropped — seeing "already gone" is the difference between a
 * screen that agrees with reality and one you stop trusting.
 */
export function reviewRows(
	swept: SweptRow[],
	live: BacklogItem[],
): ReviewRow[] {
	const liveKeys = new Set(live.map((item) => item.key));
	return swept
		.map((row, index) => ({
			...row,
			n: index + 1,
			stale: !liveKeys.has(row.key),
		}))
		.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.n - b.n);
}

/** What the header counts, by verdict. */
export function countByVerdict(rows: ReviewRow[]): {
	drop: number;
	keep: number;
	unknown: number;
} {
	return {
		drop: rows.filter((r) => r.verdict === "DROP" && !r.stale).length,
		keep: rows.filter((r) => r.verdict === "KEEP").length,
		unknown: rows.filter((r) => r.verdict === "UNKNOWN").length,
	};
}
