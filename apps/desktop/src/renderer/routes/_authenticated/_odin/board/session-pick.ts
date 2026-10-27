import type { PaneStatus } from "renderer/stores/tabs/types";

/** What a bulk action reads off a ticked row: its column, and whether it ever started. */
export interface PickedCard {
	status: PaneStatus;
	pane: { id: string; odinQueued?: unknown };
}

/**
 * The ticked rows a bulk Resume brings back: sessions with no Claude in them
 * (the Idle column with the PTY gone) and ones never started (queued). A live
 * session is left alone - Resume kills and respawns it, and a working one
 * would lose its turn. Same rule as the card's own Resume button.
 */
export function resumable<T extends PickedCard>(
	cards: readonly T[],
	live: ReadonlySet<string>,
): T[] {
	return cards.filter(
		(card) =>
			!!card.pane.odinQueued ||
			(card.status === "idle" && !live.has(card.pane.id)),
	);
}

/** The ticked rows Move to Idle parks: the ones not already there. */
export function parkable<T extends PickedCard>(cards: readonly T[]): T[] {
	return cards.filter((card) => card.status !== "idle");
}

/** One ticked session as a Merge hands it to the new session. */
export interface MergePart {
	title: string;
	/** The ask the session started from. */
	brief: string | null;
	/** Claude's session id: its transcript is the whole conversation. */
	sessionId?: string;
	/** Its brief's STATUS line, where it stands now. */
	status?: string;
	cwd?: string;
}

/**
 * The prompt Merge starts one session from: each ticked session's ask, where
 * it stands and where its transcript is, so the new one carries all of them
 * on as one piece of work. The first line is the new card's title.
 */
export function mergePrompt(parts: readonly MergePart[]): string {
	const sections = parts.map((part, i) => {
		const ask = (part.brief ?? "")
			.split("\n")
			.filter((line) => line.trim() !== part.title.trim())
			.join("\n")
			.trim();
		const facts = [
			part.sessionId &&
				`Transcript: ~/.claude/projects/*/${part.sessionId}.jsonl`,
			part.cwd && `Checkout: ${part.cwd}`,
			part.status && `Last status: ${part.status}`,
		].filter(Boolean);
		return [`## ${i + 1}. ${part.title}`, ...facts, ...(ask ? ["", ask] : [])]
			.join("\n")
			.trim();
	});
	return [
		`Merged: ${parts.map((part) => part.title).join(" + ")}`,
		"",
		`These ${parts.length} sessions are merged into this one - carry their work on together as one task. Read each transcript before you act: it holds what was already done and decided. Don't redo finished work, and reuse the branches and PRs they opened.`,
		"",
		...sections.flatMap((section) => [section, ""]),
	]
		.join("\n")
		.trim();
}
