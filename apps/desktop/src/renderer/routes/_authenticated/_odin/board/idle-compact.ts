import type { PaneStatus } from "shared/tabs-types";

/** The slice of a board session the compaction trigger reads. */
export type CompactablePane = {
	status?: PaneStatus;
	odinParked?: boolean;
	odinQueued?: unknown;
	odinStatusAt?: number;
	odinCompactedAt?: number;
};

export type IdleArrivalInput = {
	/** Settings → Sessions, "Compact conversations moved to Idle". */
	enabled: boolean;
	/** One of the board's own Claude sessions. */
	isAgent: boolean;
	alive: boolean;
	/** Under /loop - it wakes itself up, and a tick could land mid-compaction. */
	looping: boolean;
	/** Its drawer is open: you may be reading it or typing into it. */
	open: boolean;
};

/**
 * What the board does with a card that just moved into Idle: "compact" types
 * /compact into it now, "hold" keeps the arrival for a later pass, "skip" lets
 * it go.
 */
export type IdleArrival = "compact" | "hold" | "skip";

/**
 * A live card moves into Idle when you drag it there to park it, or when Ping
 * me puts it under "Waiting on others". Either way you have put it down, and
 * that is the moment to compact: Claude's cache of a conversation goes cold
 * after an hour of silence, and the next reply then re-reads the whole thing
 * at full price. Compacted while the cache is warm, the summary is cheap to
 * write, and whatever comes next starts from the summary. A Done or Needs you
 * card is never touched - you may be about to answer it, and a summary would
 * lose the detail that answer needs.
 *
 * "hold" is for an open drawer only: you may be reading it or typing into it,
 * and the command would land under a half-written message, so the arrival
 * waits for the drawer to close. Everything else lets the arrival go: a dead
 * session has no prompt to type into, a looping one wakes itself up, a queued
 * one has no process yet, and one compacted since its last Start
 * (`odinCompactedAt`) waits for a real turn - a summary of a summary loses
 * detail for nothing. A card that only comes back to Idle after its own
 * compaction is that last case.
 */
export function onIdleArrival(
	pane: CompactablePane,
	input: IdleArrivalInput,
): IdleArrival {
	if (!input.enabled) return "skip";
	if (!input.isAgent || !input.alive || input.looping) return "skip";
	if (pane.odinQueued) return "skip";
	if (pane.odinCompactedAt !== undefined) return "skip";
	return input.open ? "hold" : "compact";
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
