import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	FEED_LIST,
	FEED_ROW,
	FilterPill,
	ROW_LINK_BUTTON,
	ROW_META,
	ROW_PRIMARY_BUTTON,
} from "../components/FeedChrome";
import { backlogSweepBrief, useBacklog } from "../hooks/builtin-automations";
import { useBacklogReview } from "../hooks/useBacklogReview";
import { useMyTasks } from "../hooks/useOdinTasks";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { countByVerdict, type ReviewRow, reviewRows } from "./verdicts";

/**
 * Review — what the backlog sweep wants gone, and one click per decision.
 *
 * The sweep itself is an ordinary agent session; this is where its answers
 * land. It reads two things and joins them: the list the app sent (held in
 * `useBacklogReview`) and the verdicts the agent wrote to disk. Nothing here
 * decides anything on its own — dropping a row is a click, and a DROP the
 * agent could not evidence is one it was told to call UNKNOWN.
 */

export const Route = createFileRoute("/_authenticated/_odin/review/")({
	component: ReviewPage,
});

/** How often the verdicts file is re-read while a sweep might be running. */
const POLL_MS = 5_000;

const VERDICT_STYLE = {
	DROP: "bg-[#331a1f] text-[#ff7a8a]",
	KEEP: "bg-[#14301f] text-[#3ecf8e]",
	UNKNOWN: "bg-[#1f1f27] text-[#8a8a97]",
} as const;

function VerdictChip({ verdict }: { verdict: ReviewRow["verdict"] }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide",
				VERDICT_STYLE[verdict],
			)}
		>
			{verdict}
		</span>
	);
}

function ReviewPage() {
	const backlog = useBacklog();
	const { swept, sweptAt, record } = useBacklogReview();
	const { remove } = useMyTasks();
	const setSlackDone = electronTrpc.slack.setDone.useMutation();
	const utils = electronTrpc.useUtils();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching } = useLaunchTaskSession();
	const navigate = useNavigate();
	// Decided here, this session's worth. A dropped row also leaves the backlog,
	// but a kept one doesn't — without this the screen never empties.
	const [decided, setDecided] = useState<Record<string, true>>({});
	const [showAll, setShowAll] = useState(false);

	const review = electronTrpc.backlogReview.read.useQuery(undefined, {
		refetchInterval: POLL_MS,
		refetchOnMount: true,
	});

	const rows = useMemo(
		() => reviewRows(swept, review.data?.verdicts ?? [], backlog),
		[swept, review.data?.verdicts, backlog],
	);
	const counts = countByVerdict(rows);
	const pending = rows.filter((row) => !decided[row.key]);
	const shown = showAll
		? pending
		: pending.filter((row) => row.verdict === "DROP");

	/**
	 * Clear one item at its source: a task is deleted, a Slack row gets the
	 * local handled marker. Slack itself is never written to, so the :eyes: is
	 * still on the message and re-reacting is not needed to undo this.
	 */
	const drop = async (row: ReviewRow) => {
		const [kind, ...rest] = row.key.split(":");
		const id = rest.join(":");
		if (kind === "task") remove(id);
		else if (kind === "slack") {
			try {
				await setSlackDone.mutateAsync({ id, done: true });
				await utils.slack.reactions.invalidate();
			} catch (error) {
				return toast.error(
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		setDecided((prev) => ({ ...prev, [row.key]: true }));
	};

	const dropAll = async () => {
		const drops = pending.filter((row) => row.verdict === "DROP" && !row.stale);
		for (const row of drops) await drop(row);
		toast.success(`Cleared ${drops.length}`);
	};

	/** The sweep, off a button. The snapshot is taken here, not by the agent. */
	const sweepNow = async () => {
		const path = review.data?.path;
		if (!path) return toast.error("Odin can't tell where to put the answers");
		if (backlog.length === 0) return toast.error("The backlog is empty");
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		// Cleared first: a stale file next to a fresh snapshot renders last
		// week's verdicts against this week's numbering, which is worse than an
		// empty screen for the minutes the sweep takes.
		await utils.client.backlogReview.clear.mutate();
		record(
			backlog.map((item) => ({
				key: item.key,
				source: item.source,
				title: item.title,
				...(item.url ? { url: item.url } : {}),
			})),
		);
		setDecided({});
		const result = await launch({
			key: "backlog-sweep",
			workspaceId: ensured.workspace.id,
			title: "Is the backlog still worth doing?",
			description: backlogSweepBrief(backlog, path),
			tags: ["review"],
		});
		if (!result.ok) return toast.error(result.error);
		await review.refetch();
		usePendingFocus.getState().focus(result.paneId);
		navigate({ to: "/board" });
	};

	const swept_ago = sweptAt
		? new Date(sweptAt).toLocaleString(undefined, {
				weekday: "short",
				hour: "2-digit",
				minute: "2-digit",
			})
		: null;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2.5 border-b border-[#25252e] px-[18px] py-2.5">
				<span className="text-[13px] font-semibold text-[#f5f5f7]">Review</span>
				<span className="text-[12px] text-[#8a8a97]">
					what the sweep wants gone, checked against the system it came from
				</span>
				<div className="flex-1" />
				{rows.length > 0 && (
					<>
						<FilterPill
							active={!showAll}
							count={counts.drop}
							onClick={() => setShowAll(false)}
						>
							Drop
						</FilterPill>
						<FilterPill
							active={showAll}
							count={counts.keep + counts.unknown}
							onClick={() => setShowAll(true)}
						>
							Keep & unknown
						</FilterPill>
					</>
				)}
				<button
					type="button"
					onClick={() => void sweepNow()}
					disabled={isLaunching}
					className={ROW_PRIMARY_BUTTON}
				>
					{isLaunching ? "Starting…" : "Sweep now"}
				</button>
			</div>

			<div className={FEED_LIST}>
				{swept.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						Nothing swept yet. "Sweep now" starts a session that checks every
						open task and queued Slack message against the system it came from,
						then writes its verdicts back here.
					</div>
				)}
				{swept.length > 0 && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						Swept {swept_ago}, {swept.length} item
						{swept.length === 1 ? "" : "s"}. No answers on disk yet — the
						session is still working, or it finished without writing the file.
					</div>
				)}
				{rows.length > 0 && shown.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						{showAll
							? "Nothing left to look at."
							: `Nothing to drop. ${counts.keep} to keep, ${counts.unknown} it couldn't check.`}
					</div>
				)}

				{shown.map((row) => (
					<div
						key={row.key}
						className={cn(FEED_ROW, "flex items-start gap-3", {
							"opacity-50": row.stale,
						})}
					>
						<span className={cn(ROW_META, "w-[28px] shrink-0 pt-0.5")}>
							{row.n}
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<VerdictChip verdict={row.verdict} />
								<span className="truncate text-[13px] text-[#f5f5f7]">
									{row.title}
								</span>
							</div>
							<div className={cn(ROW_META, "mt-1")}>
								<span className="text-[#a394ff]">{row.source}</span>
								{row.evidence && <> · {row.evidence}</>}
								{row.stale && <> · already gone from the backlog</>}
							</div>
						</div>
						{row.url && (
							<a
								href={row.url}
								target="_blank"
								rel="noreferrer"
								className={ROW_LINK_BUTTON}
							>
								Open
							</a>
						)}
						<button
							type="button"
							onClick={() =>
								setDecided((prev) => ({ ...prev, [row.key]: true }))
							}
							className={ROW_LINK_BUTTON}
						>
							Keep
						</button>
						<button
							type="button"
							onClick={() => void drop(row)}
							disabled={row.stale}
							className={ROW_PRIMARY_BUTTON}
						>
							Drop
						</button>
					</div>
				))}

				{!showAll && shown.some((row) => row.verdict === "DROP") && (
					<button
						type="button"
						onClick={() => void dropAll()}
						className={cn(ROW_PRIMARY_BUTTON, "mt-1 self-center")}
					>
						Drop all{" "}
						{shown.filter((r) => r.verdict === "DROP" && !r.stale).length}
					</button>
				)}
			</div>
		</div>
	);
}
