import { cn } from "@odin/ui/utils";
import { useBacklogReview, useReview } from "../hooks/useBacklogReview";
import { useOdinProfile } from "../hooks/useOdinProfile";
import type { SweptRow } from "../review/verdicts";
import { PILL } from "./pill";

/**
 * The Review sweep's DROP verdict on a task, with Keep beside it - the same
 * red mark on every screen that names a task (All, every feed tab, the side
 * panel, Next in line, a board card), so the sweep's call can be seen and
 * overruled wherever the task is, not only on Review.
 *
 * Keep is Review's own Keep: the row turns KEEP and stays KEEP through later
 * sweeps, so the mark goes away everywhere at once.
 *
 * `inline` is the chip a one-line row has room for; the evidence is its
 * tooltip. Without it, a full-width line under a card, evidence written out.
 */
export function DropHint({
	row,
	inline = false,
}: {
	row: SweptRow;
	inline?: boolean;
}) {
	const { activeId } = useOdinProfile();
	const keep = (event: React.MouseEvent) => {
		event.stopPropagation();
		useBacklogReview.getState().keep(activeId, row.key);
	};
	const why = `The Review sweep says drop this: ${row.evidence}`;
	const keepButton = (
		<button
			type="button"
			onClick={keep}
			title="Keep it - the sweep stops suggesting a drop, here and on Review"
			className="shrink-0 rounded-[5px] px-1.5 py-px text-[11px] font-semibold text-soft-foreground ring-1 ring-inset ring-border transition-colors hover:bg-secondary hover:text-foreground"
		>
			Keep
		</button>
	);
	if (inline)
		return (
			<span className="inline-flex shrink-0 items-center gap-1">
				<span
					title={why}
					className={cn(
						"rounded-[5px] px-[7px] py-px text-[11px] font-semibold",
						PILL.danger,
					)}
				>
					Drop?
				</span>
				{keepButton}
			</span>
		);
	return (
		<div
			title={why}
			className={`mt-1 flex w-full items-start gap-1.5 rounded-[5px] px-[7px] py-px text-[11px] font-medium ${PILL.danger}`}
		>
			<span className="line-clamp-2 min-w-0 flex-1">Drop? {row.evidence}</span>
			{keepButton}
		</div>
	);
}

/**
 * The sweep's DROP for a task, by its key or its link - PRs are keyed by id
 * in the feeds and by repo#number in the sweep, so the link is what joins them.
 */
export function useSweepDrop(
	itemKey: string,
	url?: string | null,
): SweptRow | undefined {
	return useReview((review) =>
		review.swept.find(
			(row) =>
				row.verdict === "DROP" &&
				(row.key === itemKey || (!!url && row.url === url)),
		),
	);
}

/** The mark for one task, or nothing when the sweep didn't say drop. */
export function SweepDrop({
	itemKey,
	url,
	inline = true,
}: {
	itemKey: string;
	url?: string | null;
	inline?: boolean;
}) {
	const row = useSweepDrop(itemKey, url);
	return row ? <DropHint row={row} inline={inline} /> : null;
}
