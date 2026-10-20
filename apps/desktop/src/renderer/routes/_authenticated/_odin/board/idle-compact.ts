import type { PaneStatus } from "shared/tabs-types";

/** The slice of a board session the compaction sweep reads. */
export type CompactablePane = {
	status?: PaneStatus;
	odinParked?: boolean;
	odinQueued?: unknown;
	odinStatusAt?: number;
	odinCompactedAt?: number;
};

export type CompactSweepInput = {
	now: number;
	/** Settings → Sessions, in ms. 0 or less turns the sweep off. */
	afterMs: number;
	/** One of the board's own Claude sessions. */
	isAgent: boolean;
	alive: boolean;
	/** Under /loop - it wakes itself up, and a tick could land mid-compaction. */
	looping: boolean;
	/** Its drawer is open: you may be reading it or typing into it. */
	open: boolean;
	/** When the board first saw the pane, for one with no status stamp. */
	firstSeen: number;
};

/**
 * Whether a session has sat at a free prompt long enough for the board to
 * type /compact into it (Settings → Sessions, "Compact idle conversations
 * after"). The point is the prompt cache: Claude's cache of a conversation
 * goes cold after an hour, and the next reply then re-reads the whole thing
 * at full price. Compacted while the cache is warm, the summary is cheap to
 * write, and whatever comes next starts from the summary.
 *
 * Only a prompt nobody is standing in takes a command: Done (the Stop hook
 * saw the turn end with nothing asked) or parked by hand. Needs you has a
 * dialog or a question on screen, and an alive session whose status nobody
 * set may be mid-turn after a reload. One compaction per turn: a summary of
 * a summary loses detail for nothing, so a session compacted since its last
 * Start (`odinCompactedAt`) waits for a real turn.
 */
export function dueForCompact(
	pane: CompactablePane,
	input: CompactSweepInput,
): boolean {
	if (input.afterMs <= 0) return false;
	if (!input.isAgent || !input.alive || input.looping || input.open)
		return false;
	if (pane.odinQueued) return false;
	const free =
		pane.status === "review" || (pane.status === "idle" && !!pane.odinParked);
	if (!free) return false;
	if (pane.odinCompactedAt !== undefined) return false;
	const since = pane.odinStatusAt ?? input.firstSeen;
	return input.now - since > input.afterMs;
}

/** Where the card was when the board typed /compact. */
export type BeforeCompact = {
	status?: PaneStatus;
	odinParked?: boolean;
	odinStatusAt?: number;
};

/**
 * What the card goes back to once the board's own compaction ends. The
 * PreCompact hook put it in Working - and the park flag was dropped with
 * it, as for any card that starts moving - but the turn it is waiting on is
 * the one from before, so its column, its park and its idle clock all come
 * back. Nothing comes back when a real turn ran meanwhile: that turn's Start
 * cleared the compaction mark, and its hooks own the status now.
 */
export function restoreAfterCompact(
	before: BeforeCompact,
	current: { odinCompactedAt?: number } | undefined,
): BeforeCompact | null {
	if (!current || current.odinCompactedAt === undefined) return null;
	return {
		status: before.status,
		odinParked: before.odinParked,
		odinStatusAt: before.odinStatusAt,
	};
}
