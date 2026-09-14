import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	FEED_LIST,
	FEED_NOTICE_BOX,
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	META_DATE,
	META_PERSON,
	META_TAG,
	META_TEXT,
	ROW_LINK_BUTTON,
	ROW_LINK_SLOT,
	ROW_LIVE_BUTTON,
	ROW_PRIMARY_BUTTON,
	ROW_PRIMARY_SLOT,
	RowActions,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import {
	HiddenToggle,
	HideButton,
	useHiddenFilter,
} from "../components/HiddenItems";
import { PersonChip } from "../components/PersonChip";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { buildRowPrompt, groupByStatus, isDoneish } from "./rows";

export const Route = createFileRoute("/_authenticated/_odin/notion/")({
	component: NotionPage,
});

/**
 * Notion — pick one of the databases the integration can see and read its rows
 * as tasks: one card each, grouped by status, with one click to start an agent
 * session on a row (or jump to the one already running on it).
 *
 * The pick is remembered in ~/.config/odin.json, so it survives a restart and
 * the shell can warm the rows on boot like every other feed.
 */

function shortDate(iso: string | null): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function NotionPage() {
	const {
		notion: rowsQuery,
		notionConfig: config,
		notionDatabaseId: databaseId,
		syncAll,
		isSyncing,
	} = useOdinFeeds();
	const utils = electronTrpc.useUtils();
	// Only worth asking once there's a token — the search 401s without one.
	const databases = electronTrpc.notion.listDatabases.useQuery(undefined, {
		enabled: config?.hasToken === true,
		staleTime: 5 * 60_000,
	});
	const setDatabase = electronTrpc.notion.setDatabase.useMutation({
		onSuccess: () => void utils.notion.getConfig.invalidate(),
		onError: (error) => toast.error(error.message),
	});
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const navigate = useNavigate();
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const panes = useTabsStore((s) => s.panes);

	const hide = useHiddenFilter(
		"notion",
		rowsQuery.data?.rows ?? [],
		(row) => row.pageId,
	);
	const rows = hide.rows;

	// pageId → the pane of the session running on that row.
	const livePaneByPage = useMemo(() => {
		const map = new Map<string, string>();
		for (const pane of Object.values(panes))
			if (!pane.completed && pane.odinPageId) map.set(pane.odinPageId, pane.id);
		return map;
	}, [panes]);

	// Grouped by status, Notion's own order kept, finished statuses last.
	const groups = useMemo(
		() => groupByStatus(rows, (pageId) => livePaneByPage.has(pageId)),
		[rows, livePaneByPage],
	);

	const handleStart = async (row: (typeof rows)[number]) => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const result = await launch({
			key: row.pageId,
			workspaceId: ensured.workspace.id,
			title: row.title,
			description: buildRowPrompt(row),
			contact: row.assignee,
			brief: `${row.title}\n${row.pageUrl}`,
			pageId: row.pageId,
			source: "notion",
		});
		if (result.ok) {
			usePendingFocus.getState().focus(result.paneId);
			navigate({ to: "/board" });
		} else {
			toast.error(result.error);
		}
	};

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<span className="shrink-0 text-[12px] text-[#8a8a97]">
					{rowsQuery.data?.dbTitle ?? "pick a database"}
					{rows.length > 0 && ` · ${rows.length} rows`}
				</span>
				<div className="ml-auto flex items-center gap-2.5">
					<HiddenToggle
						count={hide.hiddenCount}
						showing={hide.showHidden}
						onToggle={() => hide.setShowHidden(!hide.showHidden)}
					/>
					<select
						value={databaseId}
						disabled={!config?.hasToken || setDatabase.isPending}
						onChange={(e) => setDatabase.mutate({ databaseId: e.target.value })}
						title="Which Notion database to read tasks from"
						className={cn(
							"max-w-[260px] cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium outline-none disabled:opacity-40",
							databaseId
								? "border-[#a394ff] bg-[#211d3a] text-[#f5f5f7]"
								: "border-[#25252e] bg-[#16161b] text-[#a5a5b3] hover:text-[#f5f5f7]",
						)}
					>
						<option value="">
							{databases.isLoading ? "loading databases…" : "Pick a database…"}
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

			<div className={FEED_LIST}>
				{config && !config.hasToken && (
					<ConnectNotice
						provider="notion"
						text="Notion isn't connected — sign in and pick the databases Odin may read."
					/>
				)}
				<FeedError error={rowsQuery.error} />
				<FeedError error={databases.error} />
				{config?.hasToken && !databaseId && (
					<Notice text="Pick a database above to list its rows as tasks. Only databases shared with the Notion integration show up." />
				)}
				{databaseId && rowsQuery.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						This database has no rows.
					</div>
				)}

				{groups.map(([status, group]) => (
					<div key={status} className="mb-1">
						<div className="flex items-center gap-2 py-1 pl-1 text-[11px] font-medium uppercase tracking-[.3px] text-[#8a8a97]">
							<span
								className={cn(
									"size-1.5 rounded-full",
									isDoneish(status) ? "bg-[#8a8a97]" : "bg-[#3ecf8e]",
								)}
							/>
							{status}
							<span className="rounded-[10px] bg-[#1f1f27] px-1.5 font-medium text-[#a5a5b3]">
								{group.length}
							</span>
						</div>
						<div className="flex flex-col gap-1.5">
							{group.map((row) => {
								const activePaneId = livePaneByPage.get(row.pageId) ?? null;
								const date = shortDate(row.updatedAt ?? row.date);
								return (
									<div
										key={row.pageId}
										className={cn(
											FEED_ROW,
											activePaneId &&
												"border-[#1a4029] border-l-2 border-l-[#3ecf8e] bg-[#0f1613]",
											!activePaneId && isDoneish(status) && "opacity-60",
											hide.isHidden(row) && "opacity-40",
										)}
									>
										<div className="flex items-center gap-3">
											<div className="min-w-0 flex-1">
												<div className="truncate text-[13px] font-semibold text-[#f5f5f7]">
													{row.title}
												</div>
											</div>
											<div className="flex shrink-0 items-center gap-2 text-[11px]">
												<span className={META_PERSON}>
													{row.assignee && (
														<PersonChip
															name={row.assignee}
															className="max-w-full truncate"
														/>
													)}
												</span>
												<span className={META_TAG}>
													{activePaneId && (
														<span className="inline-flex items-center gap-1 rounded-[5px] bg-[#14301f] px-[7px] py-[1px] font-semibold text-[#3ecf8e]">
															<span className="size-1.5 animate-pulse rounded-full bg-current" />
															live
														</span>
													)}
												</span>
												<span className={META_TAG}>{row.priority}</span>
												<span className={META_TEXT}>{row.channel}</span>
												<span className={META_DATE}>{date}</span>
											</div>
											<div className="flex shrink-0 items-center gap-1.5">
												<span className={ROW_LINK_SLOT}>
													<button
														type="button"
														onClick={() => openUrl.mutate(row.pageUrl)}
														className={ROW_LINK_BUTTON}
													>
														Page ↗
													</button>
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
															disabled={isLaunching}
															onClick={() => void handleStart(row)}
															className={ROW_PRIMARY_BUTTON}
														>
															{launchingKey === row.pageId
																? "Starting…"
																: "Start session"}
														</button>
													)}
												</span>
												<RowActions>
													<HideButton
														hidden={hide.isHidden(row)}
														onClick={() => hide.toggle(row)}
													/>
												</RowActions>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function Notice({ text }: { text: string }) {
	return (
		<div
			className={cn(
				FEED_NOTICE_BOX,
				"border border-[#25252e] bg-[#111114] text-[#a5a5b3]",
			)}
		>
			{text}
		</div>
	);
}
