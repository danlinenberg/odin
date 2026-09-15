import { electronTrpc } from "renderer/lib/electron-trpc";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { pullRequests, sessionBrief, slackThread } from "./brief";

/**
 * Session brief — the drawer's side panel. Answers "what did I walk into?".
 *
 * A model writes it, because excerpts don't work: the opening request is a wall
 * of prose in whatever language it was typed in, and the agent's last turn is
 * 300 words of markdown. Both need reading, which is the job the panel is
 * supposed to be doing for you.
 */

function Section({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
				{label}
			</div>
			<div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[#d6d6dc]">
				{children}
			</div>
		</div>
	);
}

/** GitHub's own colours, so merged/open/closed read without a legend. */
const STATE_CHIP: Record<string, { label: string; className: string }> = {
	MERGED: { label: "merged", className: "bg-[#241a3f] text-[#a371f7]" },
	OPEN: { label: "open", className: "bg-[#14301f] text-[#3ecf8e]" },
	CLOSED: { label: "closed", className: "bg-[#331a20] text-[#f0647a]" },
};

function StateChip({ state }: { state: string | null }) {
	// No chip while the lookup is in flight, or when gh couldn't answer.
	const chip = state ? STATE_CHIP[state] : undefined;
	if (!chip) return null;
	return (
		<span
			className={`shrink-0 rounded-[4px] px-[5px] text-[10px] font-medium ${chip.className}`}
		>
			{chip.label}
		</span>
	);
}

export function SessionBrief({
	paneId,
	cwd,
	claudeSessionId,
	marker,
	live,
}: {
	paneId: string;
	cwd: string | null;
	claudeSessionId: string | null;
	/** Card title — identifies the transcript for sessions launched without an id. */
	marker: string;
	live: boolean;
}) {
	// Same lookup Resume uses: the pane's own conversation id, then the legacy
	// localStorage mirror for panes launched before that was recorded, then —
	// for the oldest ones, which have neither — the newest transcript in the
	// session's directory that mentions the task.
	// Your own notes. Written straight to the persisted store on each keystroke:
	// it's a handful of characters into localStorage, and anything cleverer
	// (debounce, save button) can lose the last words you typed.
	const notes = usePaneMeta((s) => s.notesByPane[paneId] ?? "");
	const setNotes = usePaneMeta((s) => s.setNotes);

	const mirrored = usePaneMeta((s) => s.sessionIdByPane[paneId]);
	const known = claudeSessionId ?? mirrored ?? null;
	const { data: found, isFetching: isSearching } =
		electronTrpc.terminal.findClaudeSession.useQuery(
			{ cwd: cwd ?? "", marker },
			{ enabled: !known && !!cwd, retry: false },
		);
	const sessionId = known ?? found?.sessionId ?? null;

	// The written brief. Slow the first time (a `claude -p` spawn, ~7s), then
	// cached in the main process until the session says something new.
	const {
		data: written,
		isFetching: isWriting,
		error,
	} = electronTrpc.terminal.summarizeClaudeSession.useQuery(
		{ sessionId: sessionId ?? "" },
		{
			enabled: !!sessionId,
			retry: false,
			staleTime: 30_000,
			// A live agent keeps working; an unchanged transcript costs one stat.
			refetchInterval: live ? 60_000 : false,
		},
	);

	// Facts, straight from the transcript — they cost nothing and they're the
	// part of the panel that stays true while the brief is still being written.
	const { data: transcript } =
		electronTrpc.terminal.readClaudeTranscript.useQuery(
			{ sessionId: sessionId ?? "" },
			{
				enabled: !!sessionId,
				retry: false,
				refetchInterval: live ? 15_000 : false,
			},
		);
	const facts = transcript ? sessionBrief(transcript.messages) : null;
	const prs = transcript ? pullRequests(transcript.messages) : [];
	const thread = transcript ? slackThread(transcript.messages) : null;
	// An <a> in the renderer would navigate the app window; PRs open in a browser.
	const openUrl = electronTrpc.external.openUrl.useMutation();

	// Which of them shipped — one `gh pr view` per link, so keep it stale-tolerant.
	const { data: prStates } = electronTrpc.terminal.pullRequestStates.useQuery(
		{ urls: prs.map((pr) => pr.url) },
		{ enabled: prs.length > 0, retry: false, staleTime: 60_000 },
	);

	return (
		<div className="flex w-[340px] shrink-0 flex-col border-l border-[#25252e] bg-[#111114]">
			<div className="flex items-center gap-2 border-b border-[#25252e] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
				What's going on
				{isWriting && !written && (
					<span className="ml-auto normal-case tracking-normal text-[#a394ff]">
						writing…
					</span>
				)}
			</div>
			<div className="flex min-h-0 flex-1 select-text cursor-text flex-col gap-3.5 overflow-y-auto px-4 py-3">
				{!sessionId ? (
					<div className="text-[12px] text-[#8a8a97]">
						{isSearching
							? "looking for the transcript…"
							: "This session has no Claude conversation id — nothing to read."}
					</div>
				) : (
					<>
						{transcript?.title && (
							<div className="text-[13px] font-semibold text-[#f5f5f7]">
								{transcript.title}
							</div>
						)}
						{error ? (
							<div className="text-[12px] text-[#f0647a]">{error.message}</div>
						) : written ? (
							<>
								{written.goal && <Section label="Goal">{written.goal}</Section>}
								{written.status && (
									<Section label="Status">{written.status}</Section>
								)}
								{/* "Your move", not "Next": the card is in Needs you because
								    something is waiting on you, and the label should say so. */}
								{written.next && (
									<Section label="Your move">{written.next}</Section>
								)}
								{/* The model ignored the shape we asked for — show what it said
								    rather than an empty panel. */}
								{written.raw && (
									<Section label="Summary">{written.raw}</Section>
								)}
							</>
						) : (
							<div className="text-[12px] text-[#8a8a97]">
								reading the conversation…
							</div>
						)}
						{thread && (
							<Section label="Slack thread">
								<button
									type="button"
									title={thread}
									onClick={() => openUrl.mutate(thread)}
									className="truncate text-left text-[12px] text-[#a394ff] hover:underline"
								>
									Open thread ↗
								</button>
							</Section>
						)}
						{prs.length > 0 && (
							<Section
								label={prs.length === 1 ? "Pull request" : "Pull requests"}
							>
								<div className="flex flex-col gap-1">
									{prs.map((pr) => (
										<button
											key={pr.url}
											type="button"
											title={pr.url}
											onClick={() => openUrl.mutate(pr.url)}
											className="flex items-center gap-1.5 text-left text-[12px] text-[#a394ff] hover:underline"
										>
											<span className="truncate">
												{pr.repo.split("/").pop()} #{pr.number}
											</span>
											<StateChip state={prStates?.[pr.url] ?? null} />
										</button>
									))}
								</div>
							</Section>
						)}
						{facts && (
							<div className="pt-2 text-[11px] text-[#8a8a97]">
								{facts.turns} turns
								{facts.at &&
									` · last activity ${new Date(facts.at).toLocaleString()}`}
								{written?.writtenAt &&
									` · brief written ${new Date(written.writtenAt).toLocaleTimeString()}`}
							</div>
						)}
					</>
				)}
				{/* Yours, not the model's — kept at the bottom and outside the
				    transcript branch above, so a session with no readable
				    conversation can still be annotated. */}
				<div className="mt-auto flex flex-col gap-1 pt-2">
					<div className="text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
						My notes
					</div>
					<textarea
						value={notes}
						onChange={(event) => setNotes(paneId, event.target.value)}
						placeholder="Notes to yourself — saved as you type."
						rows={4}
						className="resize-y rounded-[7px] border border-[#25252e] bg-[#0a0a0c] px-2 py-1.5 text-[12.5px] leading-relaxed text-[#d6d6dc] placeholder:text-[#7c7c88] focus:border-[#a394ff] focus:outline-none"
					/>
				</div>
			</div>
		</div>
	);
}
