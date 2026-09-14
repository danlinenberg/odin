import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	REACTION_STATUSES,
	type ReactionStatus,
} from "lib/trpc/routers/slack/reactions";
import { useMemo, useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { emojify } from "renderer/lib/emoji";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	FEED_LIST,
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	FilterPill,
	META_DATE,
	META_PERSON,
	META_TEXT,
	ROW_LINK_BUTTON,
	ROW_LINK_SLOT,
	ROW_LIVE_BUTTON,
	ROW_PRIMARY_BUTTON,
	ROW_PRIMARY_SLOT,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { PersonChip } from "../components/PersonChip";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { buildThreadPrompt } from "../thread-prompt";

export const Route = createFileRoute("/_authenticated/_odin/reactions/")({
	component: ReactionsPage,
});

/**
 * Slack — every message I put the queue reaction (:eyes: by default, click it
 * in the header to change) on, straight from Slack. React in Slack, it shows
 * up here; Start session ingests the thread.
 *
 * Rows persist locally — removing the reaction in Slack leaves the row alone,
 * and Done is Odin-only — nothing is written to Slack.
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
	const { reactions, syncAll, isSyncing } = useOdinFeeds();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const navigate = useNavigate();
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const markStarted = electronTrpc.slack.markStarted.useMutation({
		onSuccess: () => void reactions.refetch(),
	});
	const setDone = electronTrpc.slack.setDone.useMutation({
		onSuccess: () => void reactions.refetch(),
		onError: (error) => toast.error(error.message),
	});

	// Which emoji queues a message. Slack names it (`eyes`), so this is a text
	// field, not a picker — see normalizeReaction.
	const [editingReaction, setEditingReaction] = useState(false);
	const setReaction = electronTrpc.slack.setReaction.useMutation({
		onSuccess: () => void reactions.refetch(),
		onError: (error) => toast.error(error.message),
	});

	// A row's live session, cross-checked against the tabs store so a killed
	// pane falls back to "Start session".
	const panes = useTabsStore((s) => s.panes);
	const activePaneFor = (id: string): string | null =>
		Object.values(panes).find(
			(pane) => pane.odinPageId === id && !pane.completed,
		)?.id ?? null;

	const data = reactions.data;
	const rows = useMemo(() => data?.rows ?? [], [data]);
	// Typed as always-present, but the main process only reloads on restart: an
	// app still running the old code answers without it, and its setReaction
	// procedure doesn't exist either. Missing value = editing isn't live yet.
	const liveReaction = data?.reaction as string | undefined;
	const reaction = liveReaction ?? "eyes";
	const canEdit = liveReaction !== undefined;

	const saveReaction = (value: string) => {
		setEditingReaction(false);
		const name = value
			.trim()
			.replace(/^:+|:+$/g, "")
			.toLowerCase();
		if (!name || name === reaction) return;
		setReaction.mutate({ name });
	};

	const counts = useMemo(() => {
		const byStatus = new Map<ReactionStatus, number>();
		for (const status of REACTION_STATUSES) byStatus.set(status, 0);
		for (const row of rows)
			byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
		return byStatus;
	}, [rows]);

	// The pill actually rendered: the pick, or the first one with anything in
	// it — so the view never opens on an empty list.
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
		if (!row.permalink) return toast.error("No Slack link for this message");
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const result = await launch({
			key: row.id,
			workspaceId: ensured.workspace.id,
			title: row.title,
			description: buildThreadPrompt(row.permalink, row.title, row.text),
			contact: row.authorName,
			brief: row.title,
			pageId: row.id,
			source: "reactions",
		});
		if (!result.ok) return toast.error(result.error);
		markStarted.mutate({ id: row.id });
		usePaneMeta.getState().setTitle(result.paneId, row.title);
		usePaneMeta.getState().setSessionId(result.paneId, result.sessionId);
		usePaneMeta.getState().setPaneForPage(row.id, result.paneId);
		usePendingFocus.getState().focus(result.paneId);
		navigate({ to: "/board" });
	};

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
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
					{/* Which emoji queues a message — the whole explanation is the tooltip. */}
					{editingReaction ? (
						<input
							// biome-ignore lint/a11y/noAutofocus: the field only exists once clicked
							autoFocus
							defaultValue={reaction}
							aria-label="Reaction to watch for"
							onBlur={(e) => saveReaction(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") saveReaction(e.currentTarget.value);
								if (e.key === "Escape") setEditingReaction(false);
							}}
							className="w-28 rounded-[7px] bg-[#1f1f27] px-2 py-1 text-[12px] text-[#f5f5f7] outline-none"
						/>
					) : (
						<button
							type="button"
							title={
								canEdit
									? `Messages I react to with :${reaction}: in Slack — click to change the emoji`
									: "Restart Odin to change this — the running app still has the old main process"
							}
							onClick={() =>
								canEdit
									? setEditingReaction(true)
									: toast.info(
											"Restart Odin to change the reaction — the running app still has the old main process.",
										)
							}
							className="shrink-0 rounded-[7px] bg-[#1f1f27] px-2.5 py-1 text-[12px] font-medium text-[#a394ff] transition-colors hover:text-[#c4b8ff]"
						>
							:{reaction}:
						</button>
					)}
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={FEED_LIST}>
				{data && !data.connected && (
					<ConnectNotice
						provider="slack"
						text="Slack isn't connected — sign in to queue messages here by reacting to them."
					/>
				)}
				{data?.syncError && (
					<div className="select-text cursor-text rounded-[10px] border border-[#5a2733] bg-[#f0647a]/10 px-3 py-2 text-xs">
						Slack sync failed: {data.syncError}
						{rows.length > 0 && " — showing the last synced rows."}
					</div>
				)}
				<FeedError error={reactions.error} />

				<div className="flex flex-col gap-1.5">
					{visible.map((row) => {
						const activePaneId = activePaneFor(row.id);
						const link = row.permalink;
						return (
							<div
								key={row.id}
								className={cn(FEED_ROW, row.done && "opacity-50")}
							>
								{/* One line per message, like every other feed — a pasted-in
								    Slack essay gets its first line here, the thread has the rest. */}
								<div className="flex items-center gap-3">
									<div
										title={row.text}
										className="min-w-0 flex-1 truncate text-[13px] text-[#f5f5f7]"
									>
										{preview(row.text) || "(no text)"}
									</div>
									<div className="flex shrink-0 items-center gap-2 text-[11px]">
										<span className={META_PERSON}>
											{row.authorName && (
												<PersonChip
													name={row.authorName}
													className="max-w-full truncate"
												/>
											)}
										</span>
										{/* ponytail: DMs have no channel name (conversations.info
										    omits it for IMs) — leave the slot empty rather than
										    show a raw id. */}
										<span className={META_TEXT}>
											{row.channelName && `#${row.channelName}`}
										</span>
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
													onClick={() => openUrl.mutate(link)}
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
													className={ROW_PRIMARY_BUTTON}
												>
													{launchingKey === row.id
														? "Starting…"
														: "Start session"}
												</button>
											)}
										</span>
										<button
											type="button"
											disabled={setDone.isPending}
											onClick={() =>
												setDone.mutate({ id: row.id, done: !row.done })
											}
											title={
												row.done ? "Move back to the queue" : "Mark handled"
											}
											className="shrink-0 rounded-[7px] bg-[#1f1f27] px-2.5 py-1 text-xs font-semibold text-[#3ecf8e] transition-colors hover:bg-[#14301f] disabled:opacity-40"
										>
											{row.done ? "↺ Undo" : "✓ Done"}
										</button>
									</div>
								</div>
							</div>
						);
					})}
				</div>

				{data?.connected && visible.length === 0 && !reactions.isFetching && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						{activeStatus === "Not started"
							? `Nothing here — react to a Slack message with :${reaction}: and hit Sync.`
							: `Nothing ${activeStatus.toLowerCase()}.`}
					</div>
				)}
			</div>
		</div>
	);
}
