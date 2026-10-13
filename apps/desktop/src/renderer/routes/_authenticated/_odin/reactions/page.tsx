import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	channelLabel,
	REACTION_STATUSES,
	type ReactionStatus,
} from "lib/trpc/routers/slack/reactions";
import { useMemo, useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { emojify } from "renderer/lib/emoji";
import {
	TABLE_LIST,
	TaskRow,
	TaskTableHeader,
	useTaskRows,
} from "../all/TaskTable";
import { useFeedItems } from "../all/use-all-items";
import {
	FeedDivider,
	FeedHeader,
	FeedSearch,
	FilterPill,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { BUTTON } from "../components/pill";
import { useOdinFeeds, useSetSlackReaction } from "../hooks/useOdinFeeds";

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

function ReactionsPage() {
	// One status at a time.
	const [statusFilter, setStatusFilter] = useState<ReactionStatus | null>(null);
	const { reactions, syncAll, isSyncing } = useOdinFeeds();
	const navigate = useNavigate();
	const area = Route.useSearch();
	const areaName =
		area.person ??
		(area.channel === undefined || area.channel === "DMs"
			? area.channel
			: channelLabel(area.channel));

	const setReaction = useSetSlackReaction();

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

	// Every status, not only Not started: the pills below pick which to show.
	const items = useFeedItems({ slack: data?.rows });
	const taskRows = useTaskRows(() => void reactions.refetch());
	const now = Date.now();

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

			<div className={TABLE_LIST}>
				{data && !data.connected && (
					<ConnectNotice
						provider="slack"
						text="Slack isn't connected - sign in to queue messages here by reacting to them."
					/>
				)}
				{data?.syncError && (
					<div className="select-text cursor-text rounded-[8px] border border-danger/40 bg-danger/10 px-3 py-2 text-xs">
						Slack sync failed: {data.syncError}
						{rows.length > 0 && " - showing the last synced rows."}
					</div>
				)}
				<FeedError error={reactions.error} />

				{visible.length > 0 && <TaskTableHeader date="Posted" />}
				{visible.map((row) => {
					const item = items.get(`slack:${row.id}`);
					return (
						item && (
							<TaskRow
								key={item.key}
								item={item}
								rows={taskRows}
								now={now}
								done={row.done}
							/>
						)
					);
				})}

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
			className="w-44 rounded-[6px] bg-secondary px-2 py-1 text-[12px] text-foreground outline-none"
		/>
	) : (
		<button
			type="button"
			title={`${title} Now :${value}:`}
			onClick={() => setEditing(true)}
			className={`shrink-0 rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors ${BUTTON.secondary}`}
		>
			{emojify(`:${value}:`)} {label}
		</button>
	);
}
