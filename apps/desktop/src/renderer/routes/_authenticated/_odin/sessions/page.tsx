import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { PersonChip } from "../components/PersonChip";
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
 * the real prompt, its own generated title, and the prose of every turn — so
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highlight every occurrence of any search term (the server tokenises them). */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
	if (terms.length === 0) return <>{text}</>;
	const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
	return (
		<>
			{text.split(pattern).map((part, index) =>
				// split() with one capture group puts matches at the odd indices.
				index % 2 === 1 ? (
					<mark
						// biome-ignore lint/suspicious/noArrayIndexKey: split() output is positional
						key={index}
						className="rounded-[3px] bg-[#a394ff]/30 px-[1px] text-[#dcd6ff]"
					>
						{part}
					</mark>
				) : (
					part
				),
			)}
		</>
	);
}

/** The conversation itself, user/assistant turns only — no tool-call noise. */
function TranscriptView({ row, terms }: { row: SessionRow; terms: string[] }) {
	const { data, isLoading, error } =
		electronTrpc.terminal.readClaudeTranscript.useQuery({
			project: row.project,
			sessionId: row.sessionId,
		});
	const ref = useRef<HTMLDivElement>(null);
	// Jump to the first hit when arriving from a search, else the latest turn.
	useEffect(() => {
		if (!data) return;
		const target = ref.current?.querySelector("mark");
		if (target) target.scrollIntoView({ block: "center" });
		else if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [data]);

	if (error) {
		return (
			<div className="flex-1 select-text cursor-text px-4 py-3 text-[12px] text-[#f0647a]">
				{error.message}
			</div>
		);
	}
	return (
		<div
			ref={ref}
			className="min-h-0 flex-1 select-text cursor-text overflow-y-auto px-4 py-3"
		>
			{isLoading && <div className="text-[12px] text-[#8a8a97]">loading…</div>}
			{data?.messages.length === 0 && (
				<div className="text-[12px] text-[#8a8a97]">
					No prose turns in this transcript.
				</div>
			)}
			<div className="flex flex-col gap-3">
				{data?.messages.map((message, index) => (
					<div
						key={`${index}-${message.at ?? ""}`}
						className={cn(
							"rounded-[9px] border px-3 py-2",
							message.role === "user"
								? "border-[#2b2646] bg-[#171524]"
								: "border-[#25252e] bg-[#141418]",
						)}
					>
						<div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.4px]">
							<span
								className={
									message.role === "user" ? "text-[#a394ff]" : "text-[#3ecf8e]"
								}
							>
								{message.role === "user" ? "you" : "claude"}
							</span>
							{message.at && (
								<span className="font-normal text-[#8a8a97]">
									{new Date(message.at).toLocaleString()}
								</span>
							)}
						</div>
						<div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[#d6d6dc]">
							<Highlight text={message.text} terms={terms} />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function SessionsPage() {
	const navigate = useNavigate();
	const [draft, setDraft] = useState("");
	const [query, setQuery] = useState("");
	const [openRow, setOpenRow] = useState<SessionRow | null>(null);
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching } = useLaunchTaskSession();
	const utils = electronTrpc.useUtils();
	const inputRef = useRef<HTMLInputElement>(null);

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

	const { data, isFetching } =
		electronTrpc.terminal.searchClaudeSessions.useQuery(
			{ query, limit: 40 },
			{ placeholderData: (previous) => previous },
		);
	// History = finished work; the board owns everything still running.
	const rows = (data?.sessions ?? []).filter(
		(row) => !liveSessionIds.has(row.sessionId),
	);
	// The server decides what counts as a term, so highlighting can't drift from
	// what was actually matched.
	const terms = data?.terms ?? [];
	// Everyone who has ever asked Odin for something, newest first — not just
	// the people in the current results, or clearing a search would empty the row.
	const askers = data?.askers ?? [];

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
		const workspace = await utils.client.workspaces.get.query({
			id: ensured.workspace.id,
		});
		const result = await launch({
			workspaceId: ensured.workspace.id,
			title: row.title,
			description: null,
			resumeSessionId: row.sessionId,
			brief: row.prompt,
		});
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		usePendingFocus.getState().focus(result.paneId);
		// `claude --resume <id>` only finds the conversation from its own project
		// directory, so say so plainly when we had to launch somewhere else.
		if (workspace?.worktreePath !== row.cwd) {
			toast.warning(
				`Resumed in ${workspace?.worktreePath} — the session ran in ${row.cwd}`,
			);
		} else {
			toast.success(`Resuming "${row.title}"`);
		}
		navigate({ to: "/board" });
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 px-[18px] pb-2.5 pt-3.5">
				<h1 className="text-[15px] font-semibold">Session History</h1>
				<span className="text-xs text-[#a5a5b3]">
					every session Odin launched · search what was said, read it, resume it
				</span>
			</div>

			<div className="flex items-center gap-2 px-[18px] pb-3">
				<input
					ref={inputRef}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="Keywords or a person — any words you remember, best matches first (e.g. datadog cost)"
					className="h-8 min-w-0 flex-1 rounded-lg border border-[#25252e] bg-[#111114] px-3 text-[12.5px] text-[#f5f5f7] outline-none placeholder:text-[#8a8a97] focus:border-[#a394ff]"
				/>
				{draft && (
					<button
						type="button"
						onClick={() => setDraft("")}
						className="rounded-lg bg-[#1f1f27] px-2.5 py-1.5 text-[11px] font-semibold text-[#a5a5b3] hover:text-[#f5f5f7]"
					>
						clear
					</button>
				)}
				<span className="shrink-0 text-[11px] text-[#8a8a97]">
					{isFetching
						? "searching…"
						: data
							? terms.length > 0
								? `best ${rows.length} matches`
								: `newest ${rows.length} sessions`
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
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						{query
							? `No Odin session mentions ${terms.map((term) => `"${term}"`).join(" or ")}, or came from anyone by that name.`
							: "Odin hasn't launched any sessions on this machine yet."}
					</div>
				)}
				<div className="flex flex-col gap-1.5">
					{rows.map((row) => (
						<div
							key={`${row.project}/${row.sessionId}`}
							className="flex items-start gap-3 rounded-[10px] border border-[#25252e] bg-[#111114] px-3 py-2.5 transition-colors hover:border-[#34343f]"
						>
							<button
								type="button"
								onClick={() => setOpenRow(row)}
								className="min-w-0 flex-1 text-left"
							>
								<div className="truncate text-[12.5px] font-semibold text-[#f5f5f7]">
									<Highlight text={row.title} terms={terms} />
								</div>
								<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[#a5a5b3]">
									{row.person && <PersonChip name={row.person} />}
									{repoLabel(row.cwd) && (
										<span
											title={row.cwd ?? undefined}
											className="rounded-[5px] bg-[#1f1f27] px-[7px]"
										>
											{repoLabel(row.cwd)}
										</span>
									)}
									{cameFrom.get(row.sessionId) && (
										<span className="rounded-[5px] bg-[#241a3f] px-[7px] text-[#a394ff]">
											{cameFrom.get(row.sessionId)}
										</span>
									)}
									<span>{agoLabel(row.updatedAt)}</span>
									<span className="text-[#8a8a97]">·</span>
									<span>{row.messages} msgs</span>
									{row.matches > 0 && (
										<span className="text-[#a394ff]">
											{row.matches} match{row.matches === 1 ? "" : "es"}
										</span>
									)}
								</div>
								{row.snippets.length > 0 ? (
									<div className="mt-1.5 flex flex-col gap-1">
										{row.snippets.map((snippet, index) => (
											<div
												key={`${index}-${snippet.role}`}
												className="text-[11.5px] leading-relaxed text-[#a5a5b3]"
											>
												<span
													className={cn(
														"mr-1.5 text-[10px] font-semibold uppercase",
														snippet.role === "user"
															? "text-[#a394ff]"
															: "text-[#3ecf8e]",
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
										<div className="mt-1.5 line-clamp-2 text-[11.5px] leading-relaxed text-[#8a8a97]">
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
								className="shrink-0 rounded-[7px] bg-[#14301f] px-2.5 py-1 text-xs font-semibold text-[#3ecf8e] hover:bg-[#1a3d28] disabled:opacity-50"
							>
								Resume
							</button>
						</div>
					))}
				</div>
			</div>

			{openRow && (
				<>
					<button
						type="button"
						aria-label="Close transcript"
						className="fixed inset-0 z-40 cursor-default bg-black/35"
						onClick={() => setOpenRow(null)}
					/>
					{/* absolute: stays inside the content area, clear of the traffic lights */}
					<div className="absolute right-0 top-0 z-50 flex h-full w-[min(900px,90vw)] flex-col border-l border-[#25252e] bg-[#111114]">
						<div className="border-b border-[#25252e] px-4 py-3.5">
							<div className="truncate text-sm font-semibold">
								{openRow.title}
							</div>
							{/* The title is Claude's own paraphrase; the task you actually
							    asked for is the opening prompt, and the transcript opens
							    scrolled past it. */}
							{openRow.prompt && (
								<div className="mt-1 line-clamp-3 select-text cursor-text text-[12px] leading-relaxed text-[#a5a5b3]">
									{openRow.prompt}
								</div>
							)}
							<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#a5a5b3]">
								{openRow.person && <PersonChip name={openRow.person} />}
								{openRow.cwd && (
									<span className="select-text cursor-text rounded-[5px] bg-[#1f1f27] px-[7px] text-[#a394ff]">
										{openRow.cwd}
									</span>
								)}
								<span>{agoLabel(openRow.updatedAt)}</span>
								<span className="select-text cursor-text text-[#8a8a97]">
									{openRow.sessionId}
								</span>
							</div>
						</div>
						<TranscriptView row={openRow} terms={terms} />
						<div className="flex gap-2 border-t border-[#25252e] px-4 py-3">
							<button
								type="button"
								disabled={isLaunching}
								onClick={() => void resume(openRow)}
								className="rounded-[7px] bg-[#14301f] px-3 py-1.5 text-xs font-semibold text-[#3ecf8e] hover:bg-[#1a3d28] disabled:opacity-50"
							>
								↻ Resume
							</button>
							<button
								type="button"
								onClick={() => setOpenRow(null)}
								className="ml-auto rounded-[7px] bg-[#1f1f27] px-3 py-1.5 text-xs font-semibold text-[#a5a5b3]"
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
