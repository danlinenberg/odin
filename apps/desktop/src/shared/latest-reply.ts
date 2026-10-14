/** What the agent's latest reply wants from you, as the brief judged it. */
export type BriefUrgency = "needs-you" | "fyi";

/** Past this, the chat view folds the latest reply and leads with its TL;DR. */
export const LONG_REPLY_CHARS = 600;

/** The agent's latest reply: its last turn with any prose in it. */
export function latestReply<T extends { role: string }>(
	messages: T[],
): T | undefined {
	return messages.findLast((message) => message.role === "assistant");
}

/**
 * The same reply, by when it was written. The transcript holds an ISO string,
 * the chat view parses it to ms - so compare instants, not text. No time on
 * either side is never a match: a brief we can't place is treated as stale.
 */
export function sameReply(
	a: string | number | null | undefined,
	b: string | number | null | undefined,
): boolean {
	const ms = (value: string | number | null | undefined) =>
		typeof value === "number" ? value : value ? Date.parse(value) : Number.NaN;
	const left = ms(a);
	return !Number.isNaN(left) && left === ms(b);
}

/**
 * The TL;DR card for the latest reply, or null while the brief still describes
 * an older one (a wrong TL;DR is worse than none) or has no LAST line.
 */
export function freshTldr(
	reply: { text: string; at?: string | number | null } | undefined,
	brief:
		| {
				last?: string | null;
				urgency?: BriefUrgency | null;
				replyAt?: string | null;
		  }
		| null
		| undefined,
): { last: string; urgency: BriefUrgency | null; long: boolean } | null {
	if (!reply || !brief?.last || !sameReply(reply.at, brief.replyAt))
		return null;
	return {
		last: brief.last,
		urgency: brief.urgency ?? null,
		long: reply.text.length > LONG_REPLY_CHARS,
	};
}

/**
 * Where the latest reply's TL;DR goes. A reply that ends in ACTION ITEMS gets
 * one box: the TL;DR leads that card, whose colour already says it needs you.
 * Any other reply gets its own TL;DR card with the Needs you / FYI mark.
 */
export function tldrPlacement(
	tldr: unknown,
	showsActionItems: boolean,
): "action-items" | "card" | null {
	if (!tldr) return null;
	return showsActionItems ? "action-items" : "card";
}
