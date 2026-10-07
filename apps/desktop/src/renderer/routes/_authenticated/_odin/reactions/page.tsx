import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	channelLabel,
	REACTION_STATUSES,
	type ReactionStatus,
} from "lib/trpc/routers/slack/reactions";
import { useMemo, useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { emojify } from "renderer/lib/emoji";
import { useDoneStore } from "renderer/stores/done";
import { openUrl } from "renderer/stores/in-app-browser";
import { useTabsStore } from "renderer/stores/tabs/store";
import { DoneButton } from "../components/DoneButton";
import {
	FEED_LIST,
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	FeedSearch,
	FilterPill,
	META_DATE,
	META_PERSON,
	META_TEXT,
	ROW_LINK_BUTTON,
	ROW_LINK_SLOT,
	ROW_LIVE_BUTTON,
	ROW_PRIMARY_SLOT,
	ROW_START_BUTTON,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { PersonChip } from "../components/PersonChip";
import { BUTTON } from "../components/pill";
import {
	useOdinFeeds,
	useSetSlackDone,
	useSetSlackReaction,
} from "../hooks/useOdinFeeds";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { useStartReaction } from "../hooks/useStartReaction";

/** Narrow to one channel or person - how Insights' Improvements links here. */
type ReactionsSearch = { channel?: string; person?: string };

export const Route = createFileRoute("/_authenticated/_odin/reactions/")({
	component: ReactionsPage,
	validateSearch: (search: Record<string, unknown>): ReactionsSearch => ({
		channel: typeof search.channel === "string" ? search.channel : undefined,
		person: typeof search.person === "string" ? search.person : undefined,
	}),
});

/**
 * Same grouping as Insights' findGaps: DMs fold into one "DMs" area, a channel
 * matches by its stored name (compared as a label) or its id.
 */
function inArea(
	row: {
		channelId: string;
		channelName: string | null;
		authorName: string | null;
	},
	area: ReactionsSearch,
): boolean {
	if (area.person !== undefined && row.authorName !== area.person) return false;
	if (area.channel === undefined) return true;
	if (area.channel === "DMs") return row.channelId.startsWith("D");
	return (
		row.channelId === area.channel ||
		row.channelName === channelLabel(area.channel)
	);
}

/**
 * Slack - every message I put the queue reaction (:eyes: by default, click it
 * in the header to change) on, straight from Slack. React in Slack, it shows
 * up here; Start session ingests the thread.
 *
 * Rows persist locally - removing the reaction in Slack leaves the row alone,
 * and Done is Odin-only - nothing is written to Slack.
 */

/** Compact "3m / 4h / Aug 4" label for a message's post time. */
/** Rows are one line, so the message's own line breaks collapse to spaces. */
const preview = (text: string) => emojify(text.replace(/\s+/g, " ").trim());

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const minutes = Math.round((Date.now() - then) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d`;
	return new Date(then).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

function ReactionsPage() {
	// One status at a time.
	const [statusFilter, setStatusFilter] = useState<ReactionStatus | null>(null);
	// ponytail: one row open at a time - click another and this one closes.
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const { reactions, syncAll, isSyncing } = useOdinFeeds();
	const { start, isLaunching, launchingKey } = useStartReaction();
	const navigate = useNavigate();
	const area = Route.useSearch();
	const areaName =
		area.person ??
		(area.channel === undefined || area.channel === "DMs"
			? area.channel
			: channelLabel(area.channel));
	const recordDone = useDoneStore((s) => s.setDone);
	const setDone = useSetSlackDone();

	const setReaction = useSetSlackReaction();

	// A row's live session, cross-checked against the tabs store so a killed
	// pane falls back to "Start session".
	const panes = useTabsStore((s) => s.panes);
	const activePaneFor = (id: string): string | null =>
		Object.values(panes).find(
			(pane) => pane.odinPageId === id && !pane.completed,
		)?.id ?? null;

	// Free text matched against the author only - a name also appears in half
	// the messages' @-mentions, so matching the text would find everything.
	const [search, setSearch] = useState("");
	const needle = search.trim().toLowerCase();

	const data = reactions.data;
	const rows = useMemo(
		() =>
			(data?.rows ?? []).filter(
				(row) =>
					inArea(row, area) &&
					(!needle || (row.authorName ?? "").toLowerCase().includes(needle)),
			),
		[data, area, needle],
	);
	const counts = useMemo(() => {
		const byStatus = new Map<ReactionStatus, number>();
		for (const status of REACTION_STATUSES) byStatus.set(status, 0);
		for (const row of rows)
			byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
		return byStatus;
	}, [rows]);

	// The pill actually rendered: the pick, or the first one with anything in
	// it - so the view never opens on an empty list.
	const activeStatus = useMemo(() => {
		if (statusFilter) return statusFilter;
		return (
			REACTION_STATUSES.find((status) => (counts.get(status) ?? 0) > 0) ??
			"Not started"
		);
	}, [statusFilter, counts]);

	const visible = useMemo(
		() => rows.filter((row) => row.status === activeStatus),
		[rows, activeStatus],
	);

	const handleStart = async (row: (typeof rows)[number]) => {
		const paneId = await start(row);
		if (!paneId) return;
		usePendingFocus.getState().focus(paneId);
		navigate({ to: "/board" });
	};

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				{areaName && (
					<FilterPill active onClick={() => navigate({ to: "/reactions" })}>
						{areaName} ×
					</FilterPill>
				)}
				{REACTION_STATUSES.map((status) => (
					<FilterPill
						key={status}
						active={status === activeStatus}
						count={counts.get(status) ?? 0}
						onClick={() => setStatusFilter(status)}
					>
						{status}
					</FilterPill>
				))}
				<div className="ml-auto flex items-center gap-2.5">
					<FeedSearch
						value={search}
						onChange={setSearch}
						placeholder="Search person"
						label="Search by person"
					/>
					<ReactionChip
						label="Queue"
						value={data?.reaction ?? "eyes"}
						title="React with this in Slack to add a message here. Click to change the emoji."
						onSave={(name) => setReaction.mutate({ name })}
					/>
					<ReactionChip
						label="Auto-start"
						value={data?.launchReaction ?? "robot_face"}
						title="React with this in Slack to add a message here and start a session on it. Click to change the emoji."
						onSave={(name) => setReaction.mutate({ name, launch: true })}
					/>
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={FEED_LIST}>
				{data && !data.connected && (
					<ConnectNotice
						provider="slack"
						text="Slack isn't connected - sign in to queue messages here by reacting to them."
					/>
				)}
				{data?.syncError && (
					<div className="select-text cursor-text rounded-[10px] border border-danger/40 bg-danger/10 px-3 py-2 text-xs">
						Slack sync failed: {data.syncError}
						{rows.length > 0 && " - showing the last synced rows."}
					</div>
				)}
				<FeedError error={reactions.error} />

				<div className="flex flex-col gap-1.5">
					{visible.map((row) => {
						const activePaneId = activePaneFor(row.id);
						const link = row.permalink;
						const expanded = expandedId === row.id;
						return (
							<div
								key={row.id}
								className={cn(FEED_ROW, row.done && "opacity-50")}
							>
								{/* One line per message, like every other feed - click it to
								    read the whole thing without leaving for Slack. */}
								<div
									className={cn(
										"flex gap-3",
										expanded ? "items-start" : "items-center",
									)}
								>
									<button
										type="button"
										title={expanded ? "Collapse" : "Show the full message"}
										onClick={() => setExpandedId(expanded ? null : row.id)}
										className={cn(
											"min-w-0 flex-1 text-left text-[13px] text-foreground",
											expanded ? "whitespace-pre-wrap" : "truncate",
										)}
									>
										{(expanded ? emojify(row.text) : preview(row.text)) ||
											"(no text)"}
									</button>
									<div className="flex shrink-0 items-center gap-2 text-[11px]">
										<span className={META_PERSON}>
											{row.authorName && (
												<PersonChip
													name={row.authorName}
													className="max-w-full truncate"
												/>
											)}
										</span>
										{/* ponytail: 1:1 DMs have no channel name (conversations.info
										    omits it for IMs) - leave the slot empty rather than
										    show a raw id. */}
										<span className={META_TEXT}>{row.channelName}</span>
										<span
											title={new Date(row.postedAt).toLocaleString()}
											className={META_DATE}
										>
											{relativeTime(row.postedAt)}
										</span>
									</div>
									<div className="flex shrink-0 items-center gap-1.5">
										<span className={ROW_LINK_SLOT}>
											{link && (
												<button
													type="button"
													onClick={() => openUrl(link)}
													className={ROW_LINK_BUTTON}
												>
													Thread ↗
												</button>
											)}
										</span>
										<span className={ROW_PRIMARY_SLOT}>
											{activePaneId ? (
												<button
													type="button"
													onClick={() => {
														usePendingFocus.getState().focus(activePaneId);
														navigate({ to: "/board" });
													}}
													className={ROW_LIVE_BUTTON}
												>
													Go to session →
												</button>
											) : (
												<button
													type="button"
													disabled={isLaunching || !row.permalink}
													onClick={() => void handleStart(row)}
													className={ROW_START_BUTTON}
												>
													{launchingKey === row.id
														? "Starting…"
														: "Start session"}
												</button>
											)}
										</span>
										<DoneButton
											done={row.done}
											disabled={setDone.isPending}
											onClick={() => {
												setDone.mutate({ id: row.id, done: !row.done });
												// Into the one Done list too, so All tasks lists it.
												recordDone(
													`slack:${row.id}`,
													row.done
														? null
														: {
																title: row.title,
																source: "Slack",
																url: row.permalink ?? null,
															},
												);
											}}
										/>
									</div>
								</div>
							</div>
						);
					})}
				</div>

				{data?.connected && visible.length === 0 && !reactions.isFetching && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						{activeStatus === "Not started"
							? `Nothing here - react to a Slack message with :${data.reaction}: (or :${data.launchReaction}: to start it right away) and hit Sync.`
							: `Nothing ${activeStatus.toLowerCase()}.`}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * One emoji the queue watches for. Slack names reactions (`eyes`), so this is
 * a text field, not a picker - see normalizeReaction.
 */
function ReactionChip({
	label,
	value,
	title,
	onSave,
}: {
	label: string;
	value: string;
	title: string;
	onSave: (name: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const save = (raw: string) => {
		setEditing(false);
		const name = raw
			.trim()
			.replace(/^:+|:+$/g, "")
			.toLowerCase();
		if (name && name !== value) onSave(name);
	};
	return editing ? (
		<input
			// biome-ignore lint/a11y/noAutofocus: the field only exists once clicked
			autoFocus
			defaultValue={value}
			aria-label={title}
			onBlur={(e) => save(e.currentTarget.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") save(e.currentTarget.value);
				if (e.key === "Escape") setEditing(false);
			}}
			className="w-44 rounded-[7px] bg-secondary px-2 py-1 text-[12px] text-foreground outline-none"
		/>
	) : (
		<button
			type="button"
			title={`${title} Now :${value}:`}
			onClick={() => setEditing(true)}
			className={`shrink-0 rounded-[7px] px-2.5 py-1 text-[12px] font-medium transition-colors ${BUTTON.secondary}`}
		>
			{emojify(`:${value}:`)} {label}
		</button>
	);
}
