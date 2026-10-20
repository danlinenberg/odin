import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { type DoneRow, sessionIdOfDocKey } from "renderer/stores/done";
import { openUrl } from "renderer/stores/in-app-browser";
import { FeedDivider, FeedHeader } from "../components/FeedChrome";
import { BUTTON } from "../components/pill";
import { TranscriptView } from "../components/TranscriptView";
import { useDone } from "../hooks/useDone";
import { useResumeSession } from "../hooks/useResumeSession";

export const Route = createFileRoute("/_authenticated/_odin/docs/")({
	component: DocsPage,
});

/** A session moved here off the board - a Read later row keyed by its conversation. */
type SessionRow = DoneRow & { key: string; sessionId: string };

/**
 * Docs - what you worked out in a session, kept to read later or hand to a
 * new task (the task box's Doc picker). Not a task: no status, no due date.
 * The files in ~/.odin/docs are the store; a title opens one in your editor.
 * Sessions moved here off the board (right-click → Move to Docs) list under
 * Sessions: a title reads the transcript, Back to board resumes it. Read later
 * rows from Tasks list here too: off the list, kept to read.
 */
function DocsPage() {
	const { data: docs = [] } = electronTrpc.system.listDocs.useQuery();
	const open = electronTrpc.external.openFileInEditor.useMutation({
		onError: (error) => toast.error(`Couldn't open the doc: ${error.message}`),
	});
	const reveal = electronTrpc.external.openInFinder.useMutation();
	const { reading, undo } = useDone();
	const { resume, isLaunching } = useResumeSession();
	const [openSession, setOpenSession] = useState<SessionRow | null>(null);

	// Sessions apart from tasks: they open and come back differently.
	const { sessions, tasks } = useMemo(() => {
		const sessions: SessionRow[] = [];
		const tasks: typeof reading = [];
		for (const row of reading) {
			const sessionId = sessionIdOfDocKey(row.key);
			if (sessionId) sessions.push({ ...row, sessionId });
			else tasks.push(row);
		}
		return { sessions, tasks };
	}, [reading]);

	/** Back on the board as a live session; off this list once it is. */
	const backToBoard = async (row: SessionRow) => {
		const ok = await resume({
			sessionId: row.sessionId,
			cwd: row.cwd ?? null,
			title: row.title,
		});
		if (!ok) return;
		undo(row);
		setOpenSession(null);
	};

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<span className="shrink-0 text-[12px] text-muted-foreground">
					saved from sessions · right-click a session → Save as doc or Move to
					Docs
				</span>
			</FeedHeader>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{docs.length === 0 ? (
					<div className="px-[18px] py-10 text-center text-[13px] text-muted-foreground">
						No docs yet. Brainstorm in a session, then right-click its card →
						Save as doc.
					</div>
				) : (
					<ul className="px-[18px] py-2">
						{docs.map((doc) => (
							<li
								key={doc.path}
								className="flex items-center gap-3 border-b border-border py-2"
							>
								<button
									type="button"
									title={doc.path}
									onClick={() => open.mutate({ path: doc.path })}
									className="min-w-0 truncate text-left text-[13px] font-semibold text-foreground hover:text-primary"
								>
									{doc.title}
								</button>
								<span className="min-w-0 truncate text-[12px] text-muted-foreground">
									{doc.path.split("/").pop()}
								</span>
								<button
									type="button"
									onClick={() => reveal.mutate(doc.path)}
									className="ml-auto shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
								>
									Show in Finder
								</button>
							</li>
						))}
					</ul>
				)}
				{sessions.length > 0 && (
					<>
						<h2 className="px-[18px] pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
							Sessions
						</h2>
						<ul className="px-[18px] py-2">
							{sessions.map((row) => (
								<li
									key={row.key}
									className="flex items-center gap-3 border-b border-border py-2"
								>
									<button
										type="button"
										title="Read the transcript"
										onClick={() => setOpenSession(row)}
										className="min-w-0 truncate text-left text-[13px] font-semibold text-foreground hover:text-primary"
									>
										{row.title}
									</button>
									{row.cwd && (
										<span className="min-w-0 truncate text-[12px] text-muted-foreground">
											{row.cwd.split("/").pop()}
										</span>
									)}
									<button
										type="button"
										title="Back to board - resume this conversation there"
										disabled={isLaunching}
										onClick={() => void backToBoard(row)}
										className="ml-auto shrink-0 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
									>
										Back to board
									</button>
									<button
										type="button"
										title="Take it off Docs - Session History still has it"
										onClick={() => undo(row)}
										className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
									>
										Forget
									</button>
								</li>
							))}
						</ul>
					</>
				)}
				{tasks.length > 0 && (
					<>
						<h2 className="px-[18px] pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
							Read later
						</h2>
						<ul className="px-[18px] py-2">
							{tasks.map((row) => (
								<li
									key={row.key}
									className="flex items-center gap-3 border-b border-border py-2"
								>
									<button
										type="button"
										title={row.url ?? undefined}
										disabled={!row.url}
										onClick={() => row.url && openUrl(row.url)}
										className="min-w-0 truncate text-left text-[13px] font-semibold text-foreground hover:text-primary disabled:hover:text-foreground"
									>
										{row.title}
									</button>
									<span className="shrink-0 text-[12px] text-muted-foreground">
										{row.source}
									</span>
									<button
										type="button"
										onClick={() => undo(row)}
										className="ml-auto shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
									>
										Back to Tasks
									</button>
								</li>
							))}
						</ul>
					</>
				)}
			</div>

			{openSession && (
				<>
					<button
						type="button"
						aria-label="Close transcript"
						className="fixed inset-0 z-40 cursor-default bg-black/35 bg-none"
						onClick={() => setOpenSession(null)}
					/>
					{/* absolute: stays inside the content area, clear of the traffic lights */}
					<div className="absolute right-0 top-0 z-50 flex h-full w-[min(900px,90vw)] flex-col border-l border-border bg-tertiary">
						<div className="border-b border-border px-4 py-3.5">
							<div className="truncate text-sm font-semibold">
								{openSession.title}
							</div>
							<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
								{openSession.cwd && (
									<span className="select-text cursor-text rounded-[5px] bg-secondary px-[7px] text-primary">
										{openSession.cwd}
									</span>
								)}
								<span className="select-text cursor-text text-muted-foreground">
									{openSession.sessionId}
								</span>
							</div>
						</div>
						<TranscriptView sessionId={openSession.sessionId} />
						<div className="flex gap-2 border-t border-border px-4 py-3">
							<button
								type="button"
								disabled={isLaunching}
								onClick={() => void backToBoard(openSession)}
								className={cn(
									"rounded-[7px] px-3 py-1.5 text-xs font-semibold disabled:opacity-50",
									BUTTON.primary,
								)}
							>
								↻ Back to board
							</button>
							<button
								type="button"
								onClick={() => setOpenSession(null)}
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
