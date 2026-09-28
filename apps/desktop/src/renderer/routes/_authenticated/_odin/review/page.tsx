import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { LuOctagonX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	FEED_LIST,
	FEED_ROW,
	FilterPill,
	ROW_LINK_BUTTON,
	ROW_META,
	ROW_PRIMARY_BUTTON,
} from "../components/FeedChrome";
import { useBacklog } from "../hooks/builtin-automations";
import { useActiveSessions } from "../hooks/useActiveSessions";
import { useBacklogReview, useSweepBacklog } from "../hooks/useBacklogReview";
import { useMyTasks } from "../hooks/useOdinTasks";
import {
	countByVerdict,
	type ReviewRow,
	reviewRows,
	sessionFor,
} from "./verdicts";

/**
 * Review — what the backlog sweep wants gone, and one click per decision.
 *
 * The sweep runs here, in Odin: pressing the button asks Jira, GitHub and
 * Slack about every backlog row and fills this list in seconds. No session is
 * started for it — it is three lookups against credentials Odin already holds,
 * and a session would only add a transcript to read.
 *
 * Nothing is decided automatically. Dropping a row is a click, and a verdict
 * the lookup couldn't evidence comes back UNKNOWN rather than DROP.
 */

export const Route = createFileRoute("/_authenticated/_odin/review/")({
	component: ReviewPage,
});

const VERDICT_STYLE = {
	DROP: "bg-[#ff7a8a]/10 text-[#ff7a8a]",
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
	const { swept, sweptAt, sweeping } = useBacklogReview();
	const sweepBacklog = useSweepBacklog();
	const { remove, todos } = useMyTasks();
	const panes = useTabsStore((state) => state.panes);
	const active = useActiveSessions();
	// The sessions still running, so a DROP row can say "stop working on this".
	const livePanes = useMemo(
		() => active.flatMap((s) => (panes[s.paneId] ? [panes[s.paneId]] : [])),
		[active, panes],
	);
	const taskPanes = useMemo(
		() =>
			new Map(
				todos.flatMap((t) => (t.paneId ? [[t.id, t.paneId] as const] : [])),
			),
		[todos],
	);
	const setSlackDone = electronTrpc.slack.setDone.useMutation();
	const utils = electronTrpc.useUtils();
	// Decided here, this session's worth. A dropped row also leaves the backlog,
	// but a kept one doesn't — without this the screen never empties.
	const [decided, setDecided] = useState<Record<string, true>>({});
	const [showAll, setShowAll] = useState(false);
	const [search, setSearch] = useState("");

	const rows = useMemo(() => reviewRows(swept, backlog), [swept, backlog]);
	const counts = countByVerdict(rows);
	const pending = rows.filter((row) => !decided[row.key]);
	// Who a row is from lives on the live backlog, not the swept snapshot — a
	// row that has since left the backlog searches without a person.
	const personByKey = useMemo(
		() => new Map(backlog.map((item) => [item.key, item.person])),
		[backlog],
	);
	// Punctuation reads as a space on both sides, so "alon derfner" finds the
	// GitHub handle alon-derfner-imagenai.
	const words = (text: string) =>
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	const needle = words(search);
	// A search looks across every verdict — who you're after is usually on a
	// KEEP row, and the Drop pill is the default.
	const shown = needle
		? pending.filter((row) =>
				words(
					[
						row.title,
						row.source,
						row.evidence,
						personByKey.get(row.key) ?? "",
						String(row.n),
					].join(" "),
				).includes(needle),
			)
		: showAll
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
		// What's on screen — a search narrows what "Drop all" clears.
		const drops = shown.filter((row) => row.verdict === "DROP" && !row.stale);
		for (const row of drops) await drop(row);
		toast.success(`Cleared ${drops.length}`);
	};

	/** The sweep, off a button. The shell also runs it on a clock. */
	const sweepNow = async () => {
		if (backlog.length === 0) return toast.error("The backlog is empty");
		try {
			if (await sweepBacklog()) setDecided({});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
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
						<input
							type="search"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(e) => {
								if (e.key !== "Escape") return;
								setSearch("");
								e.currentTarget.blur();
							}}
							placeholder="Search title or person"
							className={cn(
								"w-[200px] rounded-full border bg-[#16161b] px-2.5 py-1 text-[12px] text-[#f5f5f7] outline-none placeholder:text-[#6b6b78] focus:border-[#a394ff]",
								search ? "border-[#a394ff]" : "border-[#25252e]",
							)}
						/>
						<FilterPill
							active={!needle && !showAll}
							count={counts.drop}
							onClick={() => {
								setShowAll(false);
								setSearch("");
							}}
						>
							Drop
						</FilterPill>
						<FilterPill
							active={!needle && showAll}
							count={counts.keep + counts.unknown}
							onClick={() => {
								setShowAll(true);
								setSearch("");
							}}
						>
							Keep & unknown
						</FilterPill>
					</>
				)}
				<button
					type="button"
					onClick={() => void sweepNow()}
					disabled={sweeping}
					className={ROW_PRIMARY_BUTTON}
				>
					{sweeping
						? `Checking ${backlog.length}…`
						: swept.length > 0
							? "Sweep again"
							: "Sweep now"}
				</button>
			</div>

			<div className={FEED_LIST}>
				{rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						Nothing swept yet. "Sweep now" takes every open task and queued
						Slack message and asks the system it came from where it stands — the
						ticket's status, whether the PR is merged, whether the thread moved
						on — then lists what it can show is done.
					</div>
				)}
				{rows.length > 0 && shown.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						{needle
							? `Nothing matches "${search.trim()}".`
							: showAll
								? "Nothing left to look at."
								: `Nothing to drop from the ${swept.length} swept${swept_ago ? ` ${swept_ago}` : ""}. ${counts.keep} to keep, ${counts.unknown} it couldn't check.`}
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
								{row.verdict === "DROP" &&
									sessionFor(row, livePanes, taskPanes) && (
										<LuOctagonX
											className="size-3.5 shrink-0 text-[#ff7a8a]"
											title="A session is still working on this — stop it"
											aria-label="A session is still working on this — stop it"
										/>
									)}
								<span className="truncate text-[13px] text-[#f5f5f7]">
									{row.title}
								</span>
							</div>
							<div className={cn(ROW_META, "mt-1")}>
								<span className="text-[#a394ff]">{row.source}</span>
								{personByKey.get(row.key) && <> · {personByKey.get(row.key)}</>}
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

				{(needle || !showAll) &&
					shown.some((row) => row.verdict === "DROP") && (
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
