import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	TABLE_LIST,
	TaskRow,
	TaskTableHeader,
	useTaskRows,
} from "../all/TaskTable";
import { useFeedItems } from "../all/use-all-items";
import {
	FEED_NOTICE_BOX,
	FeedDivider,
	FeedHeader,
	FeedSearch,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { groupByStatus, isDoneish } from "./rows";

/** A row as Done wants it: its All-feed key, and enough to list it later. */
const doable = (row: { pageId: string; title: string; pageUrl: string }) => ({
	key: `notion:${row.pageId}`,
	title: row.title,
	source: "Notion",
	url: row.pageUrl,
});

export const Route = createFileRoute("/_authenticated/_odin/notion/")({
	component: NotionPage,
});

/**
 * Notion - pick one of the databases the integration can see and read its rows
 * as tasks: one card each, grouped by status, with one click to start an agent
 * session on a row (or jump to the one already running on it).
 *
 * The pick is remembered in ~/.config/odin.json, so it survives a restart and
 * the shell can warm the rows on boot like every other feed.
 */

function NotionPage() {
	const {
		notion: rowsQuery,
		notionConfig: config,
		notionDatabaseId: databaseId,
		notionMentions: mentions,
		syncAll,
		isSyncing,
	} = useOdinFeeds();
	const utils = electronTrpc.useUtils();
	// Only worth asking once there's a token - the search 401s without one.
	const databases = electronTrpc.notion.listDatabases.useQuery(undefined, {
		enabled: config?.hasToken === true,
		staleTime: 5 * 60_000,
	});
	const setDatabase = electronTrpc.notion.setDatabase.useMutation({
		onSuccess: () => void utils.notion.getConfig.invalidate(),
		onError: (error) => toast.error(error.message),
	});
	const setMentions = electronTrpc.notion.setMentions.useMutation({
		onSuccess: () => void utils.notion.getConfig.invalidate(),
		onError: (error) => toast.error(error.message),
	});
	const panes = useTabsStore((s) => s.panes);

	const { isDone } = useDone();
	const rows = useMemo(
		() => (rowsQuery.data?.rows ?? []).filter((row) => !isDone(doable(row))),
		[rowsQuery.data, isDone],
	);
	// Free text over the title and every field value on the row.
	const [search, setSearch] = useState("");
	const needle = search.trim().toLowerCase();
	const shown = useMemo(
		() =>
			needle
				? rows.filter((row) =>
						[row.title, row.status ?? "", ...Object.values(row.fields)]
							.join(" ")
							.toLowerCase()
							.includes(needle),
					)
				: rows,
		[rows, needle],
	);

	// pageId → the pane of the session running on that row.
	const livePaneByPage = useMemo(() => {
		const map = new Map<string, string>();
		for (const pane of Object.values(panes))
			if (!pane.completed && pane.odinPageId) map.set(pane.odinPageId, pane.id);
		return map;
	}, [panes]);

	// Grouped by status, Notion's own order kept, finished statuses last.
	const groups = useMemo(
		() => groupByStatus(shown, (pageId) => livePaneByPage.has(pageId)),
		[shown, livePaneByPage],
	);

	const items = useFeedItems({ notion: rows });
	const taskRows = useTaskRows();
	const now = Date.now();

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<span className="shrink-0 text-[12px] text-muted-foreground">
					{rowsQuery.data?.dbTitle ??
						(mentions ? "mentions" : "pick a database")}
					{rows.length > 0 && ` · ${rows.length} rows`}
				</span>
				<div className="ml-auto flex items-center gap-2.5">
					{rows.length > 0 && (
						<FeedSearch
							value={search}
							onChange={setSearch}
							label="Search Notion rows"
						/>
					)}
					<button
						type="button"
						aria-pressed={mentions}
						disabled={!config?.hasToken || setMentions.isPending}
						onClick={() => setMentions.mutate({ enabled: !mentions })}
						title="Also list pages assigned to you and open comment threads that @-mention you"
						className={cn(
							"shrink-0 cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium disabled:opacity-40",
							mentions
								? "border-primary bg-primary/15 text-foreground"
								: "border-border bg-card text-muted-foreground hover:text-foreground",
						)}
					>
						@ Mentions
					</button>
					<select
						value={databaseId}
						disabled={!config?.hasToken || setDatabase.isPending}
						onChange={(e) => setDatabase.mutate({ databaseId: e.target.value })}
						title="Which Notion database to read tasks from"
						className={cn(
							"max-w-[260px] cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium outline-none disabled:opacity-40",
							databaseId
								? "border-primary bg-primary/15 text-foreground"
								: "border-border bg-card text-muted-foreground hover:text-foreground",
						)}
					>
						<option value="">
							{databases.isLoading ? "loading databases…" : "No database"}
						</option>
						{/* A database picked before (or set by env) that the search
						    didn't return still has to show as selected. */}
						{databaseId &&
							!databases.data?.some((db) => db.id === databaseId) && (
								<option value={databaseId}>
									{rowsQuery.data?.dbTitle ?? databaseId}
								</option>
							)}
						{(databases.data ?? []).map((db) => (
							<option key={db.id} value={db.id}>
								{db.title}
							</option>
						))}
					</select>
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={TABLE_LIST}>
				{config && !config.hasToken && (
					<ConnectNotice
						provider="notion"
						text="Notion isn't connected - sign in and pick the databases Odin may read."
					/>
				)}
				<FeedError error={rowsQuery.error} />
				<FeedError error={databases.error} />
				{config?.hasToken && !databaseId && !mentions && (
					<Notice text="Pick a database above to list its rows as tasks, or turn on @ Mentions to list only what Notion says mentions you. Only databases shared with the Notion integration show up." />
				)}
				{(databaseId || mentions) && rowsQuery.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						{databaseId
							? "This database has no rows."
							: "Nothing assigned to you or mentioning you on the pages Odin was given. Pick a teamspace's top-level pages when connecting Notion; their subpages come with them."}
					</div>
				)}
				{needle && rows.length > 0 && shown.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						No rows match your search
					</div>
				)}

				{groups.length > 0 && <TaskTableHeader />}
				{groups.map(([status, group]) => (
					<div key={status} className="mb-1">
						<div className="flex items-center gap-2 py-1 pl-1 text-[11px] font-medium uppercase tracking-[.3px] text-muted-foreground">
							<span
								className={cn(
									"size-1.5 rounded-full",
									isDoneish(status) ? "bg-muted-foreground" : "bg-working",
								)}
							/>
							{status}
							<span className="rounded-[10px] bg-secondary px-1.5 font-medium text-muted-foreground">
								{group.length}
							</span>
						</div>
						{group.map((row) => {
							const item = items.get(`notion:${row.pageId}`);
							return (
								item && (
									<TaskRow
										key={item.key}
										item={item}
										rows={taskRows}
										now={now}
									/>
								)
							);
						})}
					</div>
				))}
				{config?.hasToken && mentions && (
					<div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
						Odin only sees the Notion pages you shared with it. To add a
						teamspace, open its top page in Notion → ••• → Connections → Odin;
						its subpages come along.
					</div>
				)}
			</div>
		</div>
	);
}

function Notice({ text }: { text: string }) {
	return (
		<div
			className={cn(
				FEED_NOTICE_BOX,
				"border border-border bg-card text-muted-foreground",
			)}
		>
			{text}
		</div>
	);
}
