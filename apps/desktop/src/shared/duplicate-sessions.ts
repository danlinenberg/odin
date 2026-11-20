import { sentryRefs } from "./sentry-refs";
import type { Pane } from "./tabs-types";

/** Ticket keys - BUGT-4008, CRR-870 - the same ask reaching you twice. */
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/** Words two unrelated titles share all the time. */
const FILLER = new Set(
	"a an the and or for of on in to with from by at is are be it this that my your our we you i fix add update investigate investigation review check pr task issue support request new".split(
		" ",
	),
);

function titleWords(title: string): Set<string> {
	return new Set(
		(
			title
				.replace(TICKET, " ")
				.toLowerCase()
				.match(/[a-z0-9]+/g) ?? []
		).filter((word) => word.length > 1 && !FILLER.has(word)),
	);
}

function tickets(pane: Pane): Set<string> {
	const text = `${pane.odinTaskTitle ?? ""} ${pane.odinBrief ?? ""}`;
	return new Set([...(text.match(TICKET) ?? []), ...sentryRefs(text)]);
}

function sharesAny<T>(a: Set<T>, b: Set<T>, atLeast = 1): boolean {
	let shared = 0;
	for (const item of a) if (b.has(item) && ++shared >= atLeast) return true;
	return false;
}

interface PaneFacts {
	pane: Pane;
	words: Set<string>;
	tickets: Set<string>;
}

/**
 * Each pane's title words and tickets, kept per pane object: the board calls
 * duplicateSessions on every pane change, and pane objects are replaced (not
 * edited) when they change, so an unchanged pane is not parsed again.
 */
const factsCache = new WeakMap<Pane, PaneFacts>();

function paneFacts(pane: Pane): PaneFacts {
	let facts = factsCache.get(pane);
	if (!facts) {
		facts = {
			pane,
			words: titleWords(pane.odinTaskTitle ?? ""),
			tickets: tickets(pane),
		};
		factsCache.set(pane, facts);
	}
	return facts;
}

/**
 * Two live cards doing the same work: pane id → the other pane's id.
 *
 * The launch guard only stops a second session on the SAME feed row. The same
 * ask arriving twice - a DM and a channel post, a Jira ticket and the Slack
 * thread about it - is two rows, and the overnight runner starts both. What
 * gives it away: the same Slack/Notion item, the same ticket key or Sentry
 * issue, or the same person asking with two title words in common.
 */
export function duplicateSessions(panes: Pane[]): Map<string, string> {
	const found = new Map<string, string>();
	const facts = panes.map(paneFacts);
	for (let i = 0; i < facts.length; i++) {
		const a = facts[i];
		for (let j = i + 1; j < facts.length; j++) {
			const b = facts[j];
			const same =
				(!!a.pane.odinPageId && a.pane.odinPageId === b.pane.odinPageId) ||
				sharesAny(a.tickets, b.tickets) ||
				(!!a.pane.odinContact &&
					a.pane.odinContact === b.pane.odinContact &&
					sharesAny(a.words, b.words, 2));
			if (!same) continue;
			if (!found.has(a.pane.id)) found.set(a.pane.id, b.pane.id);
			if (!found.has(b.pane.id)) found.set(b.pane.id, a.pane.id);
		}
	}
	return found;
}
