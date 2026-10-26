import type { SelectWorkLog } from "@odin/local-db";
import { sentryRefs } from "shared/sentry-refs";
import type { Pane } from "shared/tabs-types";
import type { AllItem } from "../all/all-items";

export type LedgerRow = Pick<
	SelectWorkLog,
	"source" | "externalId" | "title" | "startedAt"
> & {
	/** The whole ask, for its refs: a live session's brief. The ledger keeps none. */
	text?: string;
};

/** A Jira key or a PR link - what names one piece of work in every feed. */
const REF =
	/\b[A-Z][A-Z0-9]+-\d+\b|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/g;
const KEY_PREFIX = /^[A-Z][A-Z0-9]+-\d+:\s*/;
// Shorter than this and unrelated asks share a title ("report issue").
const MIN_TITLE_WORDS = 4;

export function refs(...texts: (string | null | undefined)[]): string[] {
	return [
		...texts.flatMap((text) => text?.match(REF) ?? []),
		...sentryRefs(...texts),
	];
}

/** The title minus its Jira key, case and punctuation - or "" if too short to trust. */
export function titleKey(title: string): string {
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
 * `ledger` can also carry the live sessions (with their brief as `text`), so
 * a Sentry alert posted to a channel and DMed a minute later is caught while
 * the first session is still running.
 *
 * Only a Slack row's body counts: a message linking a ticket is about it,
 * while a ticket or PR description cites other tickets in passing.
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
				(refs(row.title, row.externalId, row.text).some((ref) =>
					mine.has(ref),
				) ||
					(title !== "" && titleKey(row.title) === title)),
		) ?? null
	);
}

/**
 * The feed sessions still running, as ledger rows that carry their brief. A
 * session's ledger row has only its title, so two Sentry alerts for one issue
 * - titled by whatever each message said - only match on the brief's link.
 */
export function liveRows(panes: Pane[], now: number): LedgerRow[] {
	return panes.flatMap((pane) =>
		!pane.completed && pane.odinSource && pane.odinPageId
			? [
					{
						source: pane.odinSource === "slack" ? "reactions" : pane.odinSource,
						externalId: pane.odinPageId,
						title: pane.odinTaskTitle ?? pane.name,
						startedAt: now,
						text: pane.odinBrief,
					},
				]
			: [],
	);
}
