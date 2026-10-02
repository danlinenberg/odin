import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { ROW_PRIMARY_BUTTON, useSearchHotkey } from "../components/FeedChrome";
import { PersonChip } from "../components/PersonChip";
import { BUTTON, PILL } from "../components/pill";
import { Highlight, TranscriptView } from "../components/TranscriptView";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { liveConversationIds } from "./live-sessions";
import { provenanceLabel } from "./provenance";

export const Route = createFileRoute("/_authenticated/_odin/sessions/")({
	component: SessionsPage,
});

/**
 * Session History — search every session Odin has launched by what was said in
 * it, read it, and resume it.
 *
 * The board can't do this: its cards are named by whatever was typed at launch
 * ("Work on Odin", twenty times over), they only cover panes that still exist,
 * and their history is de-ANSI'd terminal mush. Claude's own transcripts have
 * the real prompt, the card's title as launched, and the prose of every turn — so
 * that's what this searches. Conversations started outside Odin live in the
 * same store and are filtered out server-side; they were never this app's work.
 *
 * Ended sessions only: a conversation still running has a live PTY and a card
 * on the board, and resuming it from here would start a second copy of it.
 */

interface SessionRow {
	project: string;
	sessionId: string;
	cwd: string | null;
	title: string;
	prompt: string | null;
	updatedAt: number;
	messages: number;
	matches: number;
	snippets: { role: "user" | "assistant"; text: string }[];
	/** Who asked, for the sessions Odin launched off Slack/Jira/PRs/Notion. */
	person: string | null;
}

function agoLabel(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(at).toLocaleDateString();
}

function repoLabel(cwd: string | null): string | null {
	return cwd ? (cwd.split("/").filter(Boolean).pop() ?? null) : null;
}

function SessionsPage() {
	const navigate = useNavigate();
	const [draft, setDraft] = useState("");
	const [query, setQuery] = useState("");
	const [openRow, setOpenRow] = useState<SessionRow | null>(null);
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching } = useLaunchTaskSession();
	const { ref: inputRef, hint } = useSearchHotkey();

	// Typing shouldn't fire a ~400ms full-store scan per keystroke.
	useEffect(() => {
		const timer = setTimeout(() => setQuery(draft.trim()), 250);
		return () => clearTimeout(timer);
	}, [draft]);

	// The whole point of the view is the search box — start in it.
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!openRow) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpenRow(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [openRow]);

	const panes = useTabsStore((state) => state.panes);
	const sessionIdByPane = usePaneMeta((state) => state.sessionIdByPane);
	// What each session was launched from. The transcript knows what was said
	// but not who asked — the work ledger is the only thing holding that link.
	const { data: ledger } = electronTrpc.workLog.list.useQuery({ limit: 500 });
	const cameFrom = useMemo(
		() =>
			new Map(
				(ledger ?? [])
					.filter((entry) => entry.sessionId !== null)
					.map((entry) => [
						entry.sessionId as string,
						provenanceLabel(entry.source, entry.externalId),
					]),
			),
		[ledger],
	);
	const { data: daemonSessions } =
		electronTrpc.terminal.listDaemonSessions.useQuery(undefined, {
			refetchInterval: 5_000,
		});
	const liveSessionIds = useMemo(
		() =>
			liveConversationIds(
				daemonSessions?.sessions ?? [],
				panes,
				sessionIdByPane,
			),
		[daemonSessions, panes, sessionIdByPane],
	);

	// Browsing pages back through the store as you scroll; a search is one
	// ranked page (the server never hands it a next cursor).
	const { data, isFetching, error, hasNextPage, fetchNextPage } =
		electronTrpc.terminal.searchClaudeSessions.useInfiniteQuery(
			{ query, limit: 40 },
			{
				getNextPageParam: (page) => page.nextCursor ?? undefined,
				placeholderData: (previous) => previous,
			},
		);
	const pages = data?.pages ?? [];
	// History = finished work; the board owns everything still running.
	const rows = pages
		.flatMap((page) => page.sessions)
		.filter((row) => !liveSessionIds.has(row.sessionId));
	// The server decides what counts as a term, so highlighting can't drift from
	// what was actually matched.
	const terms = pages[0]?.terms ?? [];
	// Everyone who has ever asked Odin for something, newest first — not just
	// the people in the current results, or clearing a search would empty the row.
	const askers = pages[0]?.askers ?? [];
	const oldest = rows.at(-1)?.updatedAt;

	// The next page loads once the list's last row scrolls into view.
	const sentinelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const sentinel = sentinelRef.current;
		if (!sentinel || !hasNextPage) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting && !isFetching) void fetchNextPage();
			},
			{ rootMargin: "400px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasNextPage, isFetching, fetchNextPage]);

	/**
	 * Resume a found session: a fresh pane running `claude --resume <id>` in the
	 * session's own directory (its original pane is long gone), then over to the
	 * board where every live session lives.
	 */
	const resume = async (row: SessionRow) => {
		if (!row.cwd) {
			toast.error(
				"This transcript has no recorded directory — can't resume it",
			);
			return;
		}
		const ensured = await ensureWorkspace(row.cwd);
		if (!ensured.ok) {
			toast.error(ensured.error);
			return;
		}
		const result = await launch({
			workspaceId: ensured.workspace.id,
			title: row.title,
			description: null,
			resumeSessionId: row.sessionId,
			// `claude --resume <id>` only finds the conversation from the directory
			// it ran in, and the workspace is the repo root — a session that ran in
			// a worktree or a subdirectory resumed into "No conversation found".
			repoPath: row.cwd,
			brief: row.prompt,
		});
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		usePendingFocus.getState().focus(result.paneId);
		toast.success(`Resuming "${row.title}"`);
		navigate({ to: "/board" });
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 px-[18px] pb-2.5 pt-3.5">
				<h1 className="text-[15px] font-semibold">Session History</h1>
				<span className="text-xs text-muted-foreground">
					every session Odin launched · search what was said, read it, resume it
				</span>
			</div>

			<div className="flex items-center gap-2 px-[18px] pb-3">
				<input
					ref={inputRef}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder={`Keywords or a person — any words you remember, best matches first (e.g. datadog cost)${hint}`}
					className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
				/>
				{draft && (
					<button
						type="button"
						onClick={() => setDraft("")}
						className="rounded-lg bg-secondary px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
					>
						clear
					</button>
				)}
				<span className="shrink-0 text-[11px] text-muted-foreground">
					{isFetching
						? "searching…"
						: data
							? terms.length > 0
								? `best ${rows.length} matches`
								: `${rows.length} sessions${oldest ? `, back to ${agoLabel(oldest)}` : ""}`
							: ""}
				</span>
			</div>

			{/* Who asked. A reporter's name is nowhere in their session's
			    transcript, so without these you'd have no way to know you can
			    search for one. */}
			{askers.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5 px-[18px] pb-3">
					{askers.map((name) => (
						<button
							key={name}
							type="button"
							onClick={() => setDraft(draft === name ? "" : name)}
							className={cn(
								"rounded-[6px] transition-opacity",
								draft === name ? "opacity-100" : "opacity-55 hover:opacity-90",
							)}
						>
							<PersonChip name={name} />
						</button>
					))}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[18px]">
				{rows.length === 0 && !isFetching && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						{/* A search that failed is not a machine with no history —
						    saying so sent this page's one real outage ("cannot find
						    module ./chunks/…", a rebuild under a running Odin) looking
						    like an empty store for hours. */}
						{error ? (
							<span className="text-danger">
								Couldn't read the session store — {error.message}
							</span>
						) : query ? (
							`No Odin session mentions ${terms.map((term) => `"${term}"`).join(" or ")}, or came from anyone by that name.`
						) : (
							"Odin hasn't launched any sessions on this machine yet."
						)}
					</div>
				)}
				<div className="flex flex-col gap-1.5">
					{rows.map((row) => (
						<div
							key={`${row.project}/${row.sessionId}`}
							className="flex items-start gap-3 rounded-[10px] border border-border bg-card px-3 py-2.5 transition-colors hover:border-input"
						>
							<button
								type="button"
								onClick={() => setOpenRow(row)}
								className="min-w-0 flex-1 text-left"
							>
								<div className="truncate text-[12.5px] font-semibold text-foreground">
									<Highlight text={row.title} terms={terms} />
								</div>
								<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
									{row.person && <PersonChip name={row.person} />}
									{repoLabel(row.cwd) && (
										<span
											title={row.cwd ?? undefined}
											className="rounded-[5px] bg-secondary px-[7px]"
										>
											{repoLabel(row.cwd)}
										</span>
									)}
									{cameFrom.get(row.sessionId) && (
										<span className={cn("rounded-[5px] px-[7px]", PILL.brand)}>
											{cameFrom.get(row.sessionId)}
										</span>
									)}
									<span>{agoLabel(row.updatedAt)}</span>
									<span className="text-muted-foreground">·</span>
									<span>{row.messages} msgs</span>
									{row.matches > 0 && (
										<span className="text-primary">
											{row.matches} match{row.matches === 1 ? "" : "es"}
										</span>
									)}
								</div>
								{row.snippets.length > 0 ? (
									<div className="mt-1.5 flex flex-col gap-1">
										{row.snippets.map((snippet, index) => (
											<div
												key={`${index}-${snippet.role}`}
												className="text-[11.5px] leading-relaxed text-muted-foreground"
											>
												<span
													className={cn(
														"mr-1.5 text-[10px] font-semibold uppercase",
														snippet.role === "user"
															? "text-primary"
															: "text-muted-foreground",
													)}
												>
													{snippet.role === "user" ? "you" : "claude"}
												</span>
												<Highlight text={snippet.text} terms={terms} />
											</div>
										))}
									</div>
								) : (
									row.prompt && (
										<div className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
											{row.prompt}
										</div>
									)
								)}
							</button>
							<button
								type="button"
								disabled={isLaunching}
								onClick={() => void resume(row)}
								title={`claude --resume ${row.sessionId}`}
								className={cn(ROW_PRIMARY_BUTTON, "disabled:opacity-50")}
							>
								Resume
							</button>
						</div>
					))}
				</div>
				<div ref={sentinelRef} />
				{rows.length > 0 && !hasNextPage && !query && (
					<div className="py-4 text-center text-[11px] text-muted-foreground">
						That's everything still on disk — Claude Code deletes transcripts
						after 30 days.
					</div>
				)}
			</div>

			{openRow && (
				<>
					<button
						type="button"
						aria-label="Close transcript"
						className="fixed inset-0 z-40 cursor-default bg-black/35 bg-none"
						onClick={() => setOpenRow(null)}
					/>
					{/* absolute: stays inside the content area, clear of the traffic lights */}
					<div className="absolute right-0 top-0 z-50 flex h-full w-[min(900px,90vw)] flex-col border-l border-border bg-tertiary">
						<div className="border-b border-border px-4 py-3.5">
							<div className="truncate text-sm font-semibold">
								{openRow.title}
							</div>
							{/* The title is the card's, often elided; the whole ask is
							    the opening prompt, and the transcript opens scrolled
							    past it. */}
							{openRow.prompt && (
								<div className="mt-1 line-clamp-3 select-text cursor-text text-[12px] leading-relaxed text-muted-foreground">
									{openRow.prompt}
								</div>
							)}
							<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
								{openRow.person && <PersonChip name={openRow.person} />}
								{openRow.cwd && (
									<span className="select-text cursor-text rounded-[5px] bg-secondary px-[7px] text-primary">
										{openRow.cwd}
									</span>
								)}
								<span>{agoLabel(openRow.updatedAt)}</span>
								<span className="select-text cursor-text text-muted-foreground">
									{openRow.sessionId}
								</span>
							</div>
						</div>
						<TranscriptView
							project={openRow.project}
							sessionId={openRow.sessionId}
							terms={terms}
						/>
						<div className="flex gap-2 border-t border-border px-4 py-3">
							<button
								type="button"
								disabled={isLaunching}
								onClick={() => void resume(openRow)}
								className={cn(
									"rounded-[7px] px-3 py-1.5 text-xs font-semibold disabled:opacity-50",
									BUTTON.primary,
								)}
							>
								↻ Resume
							</button>
							<button
								type="button"
								onClick={() => setOpenRow(null)}
								className="ml-auto rounded-[7px] bg-secondary px-3 py-1.5 text-xs font-semibold text-muted-foreground"
							>
								Close
							</button>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
