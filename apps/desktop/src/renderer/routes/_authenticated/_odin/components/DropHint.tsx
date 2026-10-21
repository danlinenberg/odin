import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { useDoneStore } from "renderer/stores/done";
import {
	droppedByHand,
	useBacklogReview,
	useReview,
} from "../hooks/useBacklogReview";
import type { Doable } from "../hooks/useDone";
import { useSetSlackDone } from "../hooks/useOdinFeeds";
import { useOdinProfile } from "../hooks/useOdinProfile";
import type { SweptRow } from "../review/verdicts";
import { PILL } from "./pill";

/** What the by-hand Drop says on hover, on a row, a card and the side panel. */
export const DROP_LABEL =
	"Drop it - Done everywhere, listed under Review's Dropped";

/**
 * Drop, wherever a task shows: the row is Done everywhere and listed under
 * Review's Dropped; a Slack row gets its handled marker - with Undo on the
 * toast. A task of yours is marked Done, not deleted, so Undo can bring it
 * back. `also` is the same task in other feeds, merged into this row: Done
 * puts them all away, and so does Drop. The sweep's DropHint and the Drop
 * on every row share this.
 */
export function useDropTask() {
	const { activeId } = useOdinProfile();
	const setSlackDone = useSetSlackDone();
	return async (row: SweptRow, also: SweptRow[] = []) => {
		const review = useBacklogReview.getState();
		const done = useDoneStore.getState().setDone;
		const rows = [row, ...also];
		const slackIds = rows.flatMap((r) =>
			r.key.startsWith("slack:") ? [r.key.slice(6)] : [],
		);
		const mark = (on: boolean) => {
			for (const r of rows) {
				if (on) review.noteDropped(activeId, r);
				else review.unnoteDropped(activeId, r.key);
				done(
					r.key,
					on ? { title: r.title, source: r.source, url: r.url ?? null } : null,
				);
			}
		};
		mark(true);
		const undo = () => {
			mark(false);
			for (const id of slackIds) setSlackDone.mutate({ id, done: false });
		};
		try {
			for (const id of slackIds)
				await setSlackDone.mutateAsync({ id, done: true });
		} catch {
			// useSetSlackDone already toasted why.
			mark(false);
			return;
		}
		toast.success(`Dropped - ${row.title}`, {
			action: { label: "Undo", onClick: undo },
		});
	};
}

/** Drop a task by hand - the same Drop, with no sweep verdict behind it. */
export function useDropByHand() {
	const drop = useDropTask();
	return (item: Doable) =>
		drop(droppedByHand(item), (item.also ?? []).map(droppedByHand));
}

/**
 * The Review sweep's DROP verdict on a task, with Keep beside it - the same
 * red mark on every screen that names a task (All, every feed tab, the side
 * panel, Next in line, a board card), so the sweep's call can be seen and
 * overruled wherever the task is, not only on Review.
 *
 * Drop does what Review's Drop does - the row is Done everywhere and listed
 * under Review's Dropped; a Slack row gets its handled marker - with Undo on
 * the toast. One difference: a task of yours is marked Done, not deleted, so
 * Undo can bring it back.
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
	const why = `The Review sweep says drop this: ${row.evidence}`;
	const dropTask = useDropTask();
	const keep = (event: React.MouseEvent) => {
		event.stopPropagation();
		useBacklogReview.getState().keep(activeId, row.key);
	};
	const drop = (event: React.MouseEvent) => {
		event.stopPropagation();
		void dropTask(row);
	};
	const dropButton = (label: string, className: string) => (
		<button
			type="button"
			onClick={drop}
			title={`${why} - click to drop it`}
			className={cn(
				"shrink-0 rounded-[5px] px-[7px] py-px text-[11px] font-semibold transition-[filter] hover:brightness-125",
				PILL.danger,
				className,
			)}
		>
			{label}
		</button>
	);
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
				{dropButton("Drop", "")}
				{keepButton}
			</span>
		);
	return (
		<div
			title={why}
			className={`mt-1 flex w-full items-start gap-1.5 rounded-[5px] px-[7px] py-px text-[11px] font-medium ${PILL.danger}`}
		>
			<span className="line-clamp-2 min-w-0 flex-1">Drop? {row.evidence}</span>
			{dropButton("Drop", "ring-1 ring-inset ring-danger/40")}
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
