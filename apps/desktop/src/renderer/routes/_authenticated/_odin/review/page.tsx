import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { LuOctagonX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useDoneStore } from "renderer/stores/done";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	FEED_LIST,
	FEED_ROW,
	FilterPill,
	ROW_LINK_BUTTON,
	ROW_META,
	ROW_PRIMARY_BUTTON,
	useSearchHotkey,
} from "../components/FeedChrome";
import { useBacklog } from "../hooks/builtin-automations";
import { useActiveSessions } from "../hooks/useActiveSessions";
import {
	type DroppedRow,
	useBacklogReview,
	useSweepBacklog,
} from "../hooks/useBacklogReview";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { useMyTasks } from "../hooks/useOdinTasks";
import {
	countByVerdict,
	foldRepeats,
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

function shortWhen(at: number): string {
	return new Date(at).toLocaleString(undefined, {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** What was dropped from here, newest first, as it looked when it went. */
function DroppedList({ rows }: { rows: DroppedRow[] }) {
	if (rows.length === 0)
		return (
			<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
				Nothing dropped yet.
			</div>
		);
	return rows.map((row) => (
		<div key={row.key} className={cn(FEED_ROW, "flex items-start gap-3")}>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<VerdictChip verdict={row.verdict} />
					<span className="truncate text-[13px] text-[#f5f5f7]">
						{row.title}
					</span>
				</div>
				<div className={cn(ROW_META, "mt-1")}>
					<span className="text-[#a394ff]">{row.source}</span>
					{row.evidence && <> · {row.evidence}</>} · dropped{" "}
					{shortWhen(row.droppedAt)}
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
		</div>
	));
}

/** "Aug 24", with the year only when it isn't this one. */
function fromDate(at: number): string {
	const date = new Date(at);
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(date.getFullYear() === new Date().getFullYear()
			? {}
			: { year: "numeric" }),
	});
}

function ReviewPage() {
	const backlog = useBacklog();
	const {
		swept,
		sweptAt,
		sweeping,
		dropped,
		noteDropped,
		unnoteDropped,
		keep,
	} = useBacklogReview();
	const sweepBacklog = useSweepBacklog();
	const { remove, todos } = useMyTasks();
	const panes = useTabsStore((state) => state.panes);
	const active = useActiveSessions();
	// The sessions still running. A row one is working on can't be dropped from
	// here — closing the session is what ends it.
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
	const hasSession = (row: ReviewRow) =>
		Boolean(sessionFor(row, livePanes, taskPanes));
	const setSlackDone = electronTrpc.slack.setDone.useMutation();
	const setDone = useDoneStore((s) => s.setDone);
	const done = useDoneStore((s) => s.done);
	const utils = electronTrpc.useUtils();
	// Decided here, this session's worth. A dropped row also leaves the backlog,
	// but a kept one doesn't — without this the screen never empties.
	const [decided, setDecided] = useState<Record<string, true>>({});
	const [view, setView] = useState<"drop" | "rest" | "dropped">("drop");
	const [search, setSearch] = useState("");
	const searchHotkey = useSearchHotkey();

	// A feed that hasn't answered since the reload isn't a backlog that emptied.
	const { reactions, jira, pulls, notion } = useOdinFeeds();
	const { isLoading: profileLoading } = useOdinProfile();
	const loadingKey = [
		profileLoading && "task",
		!reactions.data && "slack",
		!jira.data && "jira",
		!pulls.data && "pr",
		!notion.data && "notion",
	]
		.filter(Boolean)
		.join(",");
	// A row dropped here lives under Dropped, not among the ones still to
	// decide — including after a re-sweep, which re-checks everything still in
	// the backlog: a Jira or PR row isn't cleared at its source, and a Slack or
	// task row can still be in the feed the sweep read.
	// Dropping is marking Done, wherever it happened — a row dropped from Next
	// in line or marked Done in All tasks is a dropped row here too.
	const allDropped = useMemo(() => {
		const here = new Set(dropped.map((row) => row.key));
		const elsewhere = swept.flatMap((row) => {
			const at = done[row.key]?.at;
			return at && !here.has(row.key) ? [{ ...row, droppedAt: at }] : [];
		});
		return [...dropped, ...elsewhere].sort((a, b) => b.droppedAt - a.droppedAt);
	}, [dropped, swept, done]);
	const droppedKeys = useMemo(
		() => new Set(allDropped.map((row) => row.key)),
		[allDropped],
	);
	const rows = useMemo(
		() =>
			foldRepeats(
				reviewRows(swept, backlog, new Set(loadingKey.split(","))).filter(
					(row) => !droppedKeys.has(row.key),
				),
			),
		[swept, backlog, loadingKey, droppedKeys],
	);
	const counts = countByVerdict(rows);
	const pending = rows.filter((row) => !decided[row.key]);
	// Who a row is from lives on the live backlog, not the swept snapshot — a
	// row that has since left the backlog searches without a person.
	const personByKey = useMemo(
		() => new Map(backlog.map((item) => [item.key, item.person])),
		[backlog],
	);
	const createdByKey = useMemo(
		() => new Map(backlog.map((item) => [item.key, item.createdAt])),
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
		: view === "rest"
			? pending
			: pending.filter((row) => row.verdict === "DROP");

	const droppable = (row: ReviewRow) =>
		row.verdict === "DROP" && !row.stale && !hasSession(row);

	/**
	 * Clear one item at its source: a task is deleted, a Slack row gets the
	 * local handled marker. Slack itself is never written to, so the :eyes: is
	 * still on the message and re-reacting is not needed to undo this.
	 */
	const drop = async (row: ReviewRow) => {
		for (const repeat of row.repeats ?? []) await drop(repeat);
		const [kind, ...rest] = row.key.split(":");
		const id = rest.join(":");
		// Off the screen first: the Slack write plus the reactions refetch take
		// seconds, and the row sat there the whole time. Put back on failure.
		setDecided((prev) => ({ ...prev, [row.key]: true }));
		noteDropped(row);
		// Dropped is done, everywhere: a Jira, PR or Notion row can't be cleared
		// at its source, and would otherwise live on in All tasks.
		setDone(row.key, {
			title: row.title,
			source: row.source,
			url: row.url ?? null,
		});
		if (kind === "task") remove(id);
		else if (kind === "slack") {
			try {
				await setSlackDone.mutateAsync({ id, done: true });
				void utils.slack.reactions.invalidate();
			} catch (error) {
				setDecided(({ [row.key]: _, ...prev }) => prev);
				unnoteDropped(row.key);
				setDone(row.key, null);
				toast.error(error instanceof Error ? error.message : String(error));
				return;
			}
		}
	};

	const dropAll = async () => {
		// What's on screen — a search narrows what "Drop all" clears.
		const drops = shown.filter(droppable);
		for (const row of drops) await drop(row);
		toast.success(`Cleared ${drops.length}`);
	};

	/** The sweep, off a button. The shell also runs it on a clock. */
	// In the header, and again mid-page when there's nothing to act on.
	const sweepButton = (className?: string) => (
		<button
			type="button"
			onClick={() => void sweepNow()}
			disabled={sweeping}
			className={cn(ROW_PRIMARY_BUTTON, className)}
		>
			{sweeping
				? `Checking ${backlog.length}…`
				: swept.length > 0
					? "Sweep again"
					: "Sweep now"}
		</button>
	);
	const sweepNow = async () => {
		if (backlog.length === 0) return toast.error("The backlog is empty");
		try {
			if (await sweepBacklog()) setDecided({});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};

	const swept_ago = sweptAt ? shortWhen(sweptAt) : null;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2.5 border-b border-[#25252e] px-[18px] py-2.5">
				<span className="text-[13px] font-semibold text-[#f5f5f7]">Review</span>
				<span className="text-[12px] text-[#8a8a97]">
					what the sweep wants gone, checked against the system it came from
				</span>
				<div className="flex-1" />
				{swept.length > 0 && (
					<>
						<input
							ref={searchHotkey.ref}
							type="search"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(e) => {
								if (e.key !== "Escape") return;
								setSearch("");
								e.currentTarget.blur();
							}}
							placeholder={`Search title or person${searchHotkey.hint}`}
							className={cn(
								"w-[200px] rounded-full border bg-[#16161b] px-2.5 py-1 text-[12px] text-[#f5f5f7] outline-none placeholder:text-[#6b6b78] focus:border-[#a394ff]",
								search ? "border-[#a394ff]" : "border-[#25252e]",
							)}
						/>
						<FilterPill
							active={!needle && view === "drop"}
							count={counts.drop}
							onClick={() => {
								setView("drop");
								setSearch("");
							}}
						>
							Drop
						</FilterPill>
						<FilterPill
							active={!needle && view === "rest"}
							count={counts.keep + counts.unknown}
							onClick={() => {
								setView("rest");
								setSearch("");
							}}
						>
							Keep & unknown
						</FilterPill>
						<FilterPill
							active={!needle && view === "dropped"}
							count={allDropped.length}
							onClick={() => {
								setView("dropped");
								setSearch("");
							}}
						>
							Dropped
						</FilterPill>
					</>
				)}
				{sweepButton()}
			</div>

			<div className={FEED_LIST}>
				{swept.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						Nothing swept yet. "Sweep now" takes every open task and queued
						Slack message and asks the system it came from where it stands — the
						ticket's status, whether the PR is merged, whether the thread moved
						on — then lists what it can show is done.
						<div>{sweepButton("mt-3")}</div>
					</div>
				)}
				{!needle && view === "dropped" && <DroppedList rows={allDropped} />}
				{swept.length > 0 &&
					shown.length === 0 &&
					(needle || view !== "dropped") && (
						<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
							{needle
								? `Nothing matches "${search.trim()}".`
								: view === "rest"
									? "Nothing left to look at."
									: `Nothing to drop from the ${swept.length} swept${swept_ago ? ` ${swept_ago}` : ""}. ${counts.keep} to keep, ${counts.unknown} it couldn't check.`}
							{!needle && view === "drop" && <div>{sweepButton("mt-3")}</div>}
						</div>
					)}

				{(needle || view !== "dropped") &&
					shown.map((row) => (
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
									{hasSession(row) && (
										<LuOctagonX
											className="size-3.5 shrink-0 text-[#ff7a8a]"
											title="A session is still working on this — close it to drop"
											aria-label="A session is still working on this — close it to drop"
										/>
									)}
									<span className="truncate text-[13px] text-[#f5f5f7]">
										{row.title}
									</span>
								</div>
								<div className={cn(ROW_META, "mt-1")}>
									<span className="text-[#a394ff]">{row.source}</span>
									{personByKey.get(row.key) && (
										<> · {personByKey.get(row.key)}</>
									)}
									{createdByKey.get(row.key) && (
										<> · from {fromDate(createdByKey.get(row.key) ?? 0)}</>
									)}
									{row.evidence && <> · {row.evidence}</>}
									{row.repeats && (
										<> · +{row.repeats.length} more from this DM</>
									)}
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
								onClick={() => {
									const keys = [
										row.key,
										...(row.repeats ?? []).map((r) => r.key),
									];
									setDecided((prev) => ({
										...prev,
										...Object.fromEntries(keys.map((key) => [key, true])),
									}));
									for (const key of keys) keep(key);
								}}
								className={ROW_LINK_BUTTON}
							>
								Keep
							</button>
							<button
								type="button"
								onClick={() => void drop(row)}
								disabled={row.stale || hasSession(row)}
								title={
									hasSession(row)
										? "A session is still working on this — close it to drop"
										: undefined
								}
								className={ROW_PRIMARY_BUTTON}
							>
								Drop
							</button>
						</div>
					))}

				{(needle || view === "drop") && shown.some(droppable) && (
					<button
						type="button"
						onClick={() => void dropAll()}
						className={cn(ROW_PRIMARY_BUTTON, "mt-1 self-center")}
					>
						Drop all {shown.filter(droppable).length}
					</button>
				)}
			</div>
		</div>
	);
}
