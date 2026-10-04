import type { SelectWorkLog } from "@odin/local-db";
import type { AllItem } from "../all/all-items";

export type LedgerRow = Pick<
	SelectWorkLog,
	"source" | "externalId" | "title" | "startedAt"
>;

/** A Jira key or a PR link - what names one piece of work in every feed. */
const REF =
	/\b[A-Z][A-Z0-9]+-\d+\b|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g;
const KEY_PREFIX = /^[A-Z][A-Z0-9]+-\d+:\s*/;
// Shorter than this and unrelated asks share a title ("report issue").
const MIN_TITLE_WORDS = 4;

function refs(...texts: (string | null | undefined)[]): string[] {
	return texts.flatMap((text) => text?.match(REF) ?? []);
}

/** The title minus its Jira key, case and punctuation - or "" if too short to trust. */
function titleKey(title: string): string {
	const words = title
		.replace(KEY_PREFIX, "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
	return words.length >= MIN_TITLE_WORDS ? words.join(" ") : "";
}

/**
 * The ledger row this item probably repeats: the same ask reaching Next in
 * line through a second feed - a Slack ping about a Jira ticket - after a
 * session already ran on the first. The ledger's own dedupe is per feed id,
 * so it can't see that. Same ticket or PR, or the same title.
 *
 * Only a Slack row's body counts: a message linking a ticket is about it,
 * while a ticket or PR description cites other tickets in passing.
 *
 * ponytail: exact refs and exact normalized titles. A reworded ask slips
 * through; hand the ledger to the ranking model if those start to.
 */
export function duplicateOf(
	item: AllItem,
	ledger: LedgerRow[],
): LedgerRow | null {
	const mine = new Set(
		refs(
			item.launch.title,
			item.url,
			item.source === "Slack" ? item.body : null,
		),
	);
	const title = titleKey(item.launch.title);
	return (
		ledger.find(
			(row) =>
				row.externalId !== item.launch.key &&
				(refs(row.title, row.externalId).some((ref) => mine.has(ref)) ||
					(title !== "" && titleKey(row.title) === title)),
		) ?? null
	);
}
