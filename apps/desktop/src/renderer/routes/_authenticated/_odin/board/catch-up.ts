import type { BriefUrgency } from "shared/latest-reply";
import {
	actionItems,
	type BriefMessage,
	mergeTargets,
	onlyLookLeft,
	onlyMergeLeft,
} from "./brief";

/**
 * The board's call on a card that asks for you, and why: Done, a duplicate,
 * only a merge left, or yours. Today reads it to put a card in Almost done.
 * Built only from what the board already knows.
 */
export interface CatchUpSuggestion {
	kind: "done" | "duplicate" | "merge" | "yours";
	/** One line: the reason, or for "yours" the first thing you owe it. */
	why: string;
	/** Where the reason came from. */
	from: string;
	/** The PR to open, on a merge. */
	url?: string;
}

export interface CatchUpSignals {
	/** The Review sweep's evidence, when it said drop this. */
	sweptDrop?: string | null;
	/** The session's own "DROPPED: <why>" - the ask was already settled. */
	selfDropped?: string | null;
	/** The PR it reviewed was merged. */
	prMerged?: boolean;
	/** Its PRs were closed unmerged. */
	prsClosed?: boolean;
	/** The title of another card on the same ask. */
	duplicateOf?: string | null;
	messages?: BriefMessage[];
	urgency?: BriefUrgency;
}

export function catchUpSuggestion(s: CatchUpSignals): CatchUpSuggestion {
	if (s.sweptDrop)
		return { kind: "done", why: s.sweptDrop, from: "Review sweep" };
	if (s.selfDropped)
		return { kind: "done", why: s.selfDropped, from: "Session" };
	if (s.prMerged)
		return {
			kind: "done",
			why: "The PR it reviewed is merged.",
			from: "GitHub",
		};
	if (s.prsClosed)
		return { kind: "done", why: "Its PRs were closed.", from: "GitHub" };
	if (s.duplicateOf)
		return {
			kind: "duplicate",
			why: `Same ask as “${s.duplicateOf}”.`,
			from: "Duplicate check",
		};
	const messages = s.messages;
	if (!messages)
		return { kind: "yours", why: "Not read yet.", from: "Transcript" };
	const items = actionItems(messages);
	if (onlyMergeLeft(messages)) {
		const pr = mergeTargets(messages)[0];
		return {
			kind: "merge",
			why: pr
				? `Only the merge of #${pr.number} is left.`
				: "Only the merge is left.",
			from: "Action items",
			url: pr?.url,
		};
	}
	if (onlyLookLeft(messages))
		return {
			kind: "done",
			why: "Only a look at what shipped is left.",
			from: "Action items",
		};
	const last = messages.findLast((m) => m.role === "assistant")?.text ?? "";
	if (!items.length && /ACTION ITEMS/i.test(last))
		return { kind: "done", why: "No action items left.", from: "Action items" };
	if (!items.length && s.urgency === "fyi")
		return {
			kind: "done",
			why: "The last reply needs nothing from you.",
			from: "Brief",
		};
	return {
		kind: "yours",
		why: items[0] ?? "Open the session to see what it needs.",
		from: items.length ? `Action item 1 of ${items.length}` : "No action items",
	};
}
