import type { BacklogItem } from "../hooks/builtin-automations";

/**
 * Joining the sweep's answers back onto the backlog.
 *
 * The agent only ever sends back a number, a verdict and a line of evidence.
 * Which row that number means is answered here, from the snapshot the app took
 * when it built the prompt — so a wrong number reviews nothing, rather than
 * clearing the wrong task.
 */

/** One item as it was sent, in prompt order. Position is the join key. */
export interface SweptItem {
	/** `task:<id>` / `slack:<id>` — the row to clear on DROP. */
	key: string;
	source: string;
	title: string;
	url?: string;
}

export interface Verdict {
	n: number;
	verdict: "DROP" | "KEEP" | "UNKNOWN";
	evidence: string;
}

/** A swept item with its answer, ready to render and decide on. */
export interface ReviewRow extends SweptItem {
	n: number;
	verdict: Verdict["verdict"];
	evidence: string;
	/** The row has since left the backlog — decided elsewhere, or already cleared. */
	stale: boolean;
}

const ORDER: Record<Verdict["verdict"], number> = {
	DROP: 0,
	UNKNOWN: 1,
	KEEP: 2,
};

/**
 * The review list: every swept item that came back with a verdict, DROPs
 * first, then the ones it couldn't reach, then what it wants kept.
 *
 * `live` is the backlog as it stands right now. An item missing from it was
 * dealt with between the sweep finishing and you opening this screen, so its
 * row is marked rather than dropped — seeing "already gone" is the difference
 * between a screen that agrees with reality and one you stop trusting.
 *
 * Items with no verdict are left out entirely. A sweep that died halfway
 * should show the nine answers it got, not twenty-eight blanks.
 */
export function reviewRows(
	swept: SweptItem[],
	verdicts: Verdict[],
	live: BacklogItem[],
): ReviewRow[] {
	const liveKeys = new Set(live.map((item) => item.key));
	const byNumber = new Map(verdicts.map((v) => [v.n, v]));
	return swept
		.map((item, index) => {
			// The prompt numbers from 1; the snapshot is an array.
			const found = byNumber.get(index + 1);
			if (!found) return null;
			return {
				...item,
				n: found.n,
				verdict: found.verdict,
				evidence: found.evidence,
				stale: !liveKeys.has(item.key),
			};
		})
		.filter((row): row is ReviewRow => row !== null)
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
