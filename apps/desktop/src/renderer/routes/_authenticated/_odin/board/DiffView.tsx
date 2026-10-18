import { type DiffLineAnnotation, PatchDiff } from "@pierre/diffs/react";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { isHotkey, useHotkeyDisplay } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DIFF_POOL_RENDER_OPTIONS } from "renderer/screens/main/components/WorkspaceView/utils/code-theme/diff-render-options";
import { pullRequests } from "./brief";
import { typeIntoClaude } from "./ChatView";
import {
	BRANCH,
	commentTarget,
	type ReviewComment,
	reviewMessage,
} from "./diff-review";

/** A comment being written: placed on the lines, no text or id yet. */
type Draft = Omit<ReviewComment, "id" | "text">;

/**
 * "What did this session actually change?" - the diff for the checkout a card
 * runs in, one file at a time, rendered by @pierre/diffs (the app's own diff
 * engine, themed by the worker pool) - nothing to install on the machine.
 *
 * The header picks which diff: the working tree, the branch's commits since
 * it left main (no PR needed), or any PR the session opened - a session that
 * shipped five PRs is five diffs, and the working tree is usually none of them.
 *
 * It is also a review: drag the gutter's + over lines to comment on them, then
 * send every comment on the diff to the session as one message - the agent gets
 * the file, the lines and the code without a word typed, and the PR on GitHub
 * gets no review comments.
 */
export function DiffView({
	paneId,
	cwd,
	claudeSessionId,
	workspaceId,
}: {
	/** The session's terminal - where the review is typed in. */
	paneId: string;
	/** Null until the session's terminal has mounted - the main process then
	 * falls back to the workspace's own checkout. */
	cwd: string | null;
	/** The conversation in this pane. Claude Code cds between repos without the
	 * shell noticing, so its transcript - not `cwd` - knows where the work is. */
	claudeSessionId: string | null;
	workspaceId: string;
}) {
	/** The diff on screen: null is the checkout's uncommitted work, BRANCH
	 * everything its branch did since it left main, else a PR's url. */
	const [choice, setChoice] = useState<string | null>(null);
	const branch = choice === BRANCH;
	const pr = branch ? null : choice;
	/** The file on screen. One at a time, so scrolling stops at its end
	 * instead of running on into the next file. */
	const [selected, setSelected] = useState(0);
	/** Soft-wrap long lines; off, they run on and the panel scrolls sideways.
	 * Remembered per machine. */
	const [wrap, setWrap] = useState(() => {
		try {
			return localStorage.getItem("odin:diff-wrap") !== "0";
		} catch {
			return true;
		}
	});
	/** Every line of each file, not only the changed hunks. Working tree only:
	 * GitHub sends a PR's diff with three lines of context and no more. */
	const [wholeFile, setWholeFile] = useState(false);
	const toggleWrap = () => {
		setWrap(!wrap);
		try {
			localStorage.setItem("odin:diff-wrap", wrap ? "0" : "1");
		} catch {}
	};
	// Same query (and cache entry) the brief beside it reads its PRs from.
	const { data: transcript } =
		electronTrpc.terminal.readClaudeTranscript.useQuery(
			{ sessionId: claudeSessionId ?? "" },
			{ enabled: !!claudeSessionId, retry: false },
		);
	const prs = transcript
		? pullRequests(transcript.links ?? transcript.messages)
		: [];
	const { data: prStates } = electronTrpc.terminal.pullRequestStates.useQuery(
		{ urls: prs.map((link) => link.url) },
		{ enabled: prs.length > 0, retry: false, staleTime: 60_000 },
	);

	/** The checkout as it was when the last review went out, as a git tree.
	 * Working tree only: a PR's later commits are on GitHub, not here. */
	const sinceKey = `odin:diff-review-since:${paneId}`;
	const [since, setSince] = useState<string | null>(() => {
		try {
			return localStorage.getItem(sinceKey);
		} catch {
			return null;
		}
	});
	/** Only what the agent changed after the review, not the whole change. */
	const [showSince, setShowSince] = useState(false);
	const sinceReview = !choice && showSince ? since : null;

	const { data, error, isFetching, refetch } = electronTrpc.repos.diff.useQuery(
		{
			cwd,
			claudeSessionId,
			workspaceId,
			pr,
			branch,
			wholeFile: !pr && wholeFile,
			since: sinceReview,
		},
		{
			refetchOnWindowFocus: false,
			retry: false,
			// Keep the last diff on screen while a refresh reads the next one.
			placeholderData: keepPreviousData,
		},
	);

	/** Review comments, sent or not. Kept per session on the machine, so a
	 * closed drawer or an app restart does not lose them. */
	const storageKey = `odin:diff-review:${paneId}`;
	const [comments, setComments] = useState<ReviewComment[]>(() => {
		try {
			return JSON.parse(localStorage.getItem(storageKey) ?? "[]");
		} catch {
			return [];
		}
	});
	const saveComments = (next: ReviewComment[]) => {
		setComments(next);
		try {
			if (next.length) localStorage.setItem(storageKey, JSON.stringify(next));
			else localStorage.removeItem(storageKey);
		} catch {}
	};
	const [draft, setDraft] = useState<Draft | null>(null);
	const [sendError, setSendError] = useState<string | null>(null);
	const write = electronTrpc.terminal.write.useMutation();
	const snapshot = electronTrpc.repos.reviewSnapshot.useMutation();

	const files = data?.files ?? [];
	const current = files[Math.min(selected, files.length - 1)];

	const review = comments.filter((comment) => comment.pr === choice);
	const unsent = review.filter((comment) => !comment.sent);
	const annotations: DiffLineAnnotation<{ id: string | null }>[] = current
		? [
				...review
					.filter((comment) => comment.path === current.path)
					.map((comment) => ({
						side: comment.side,
						lineNumber: comment.lineNumber,
						metadata: { id: comment.id },
					})),
				...(draft?.pr === choice && draft.path === current.path
					? [
							{
								side: draft.side,
								lineNumber: draft.lineNumber,
								metadata: { id: null },
							},
						]
					: []),
			]
		: [];

	const sendReview = async () => {
		setSendError(null);
		try {
			// Before the message, so the snapshot is the code the review is about.
			if (!choice) {
				const { tree } = await snapshot.mutateAsync({
					cwd,
					claudeSessionId,
					workspaceId,
				});
				setSince(tree);
				try {
					localStorage.setItem(sinceKey, tree);
				} catch {}
			}
			await typeIntoClaude(
				write.mutateAsync,
				paneId,
				reviewMessage(unsent, choice),
			);
			saveComments(
				comments.map((comment) =>
					comment.pr === choice ? { ...comment, sent: true } : comment,
				),
			);
		} catch (sendFailure) {
			setSendError(
				sendFailure instanceof Error
					? sendFailure.message
					: String(sendFailure),
			);
		}
	};

	const total = files.reduce(
		(sum, file) => ({
			added: sum.added + file.added,
			removed: sum.removed + file.removed,
		}),
		{ added: 0, removed: 0 },
	);

	// Grouped by repo: a session's PRs pile up in one or two repos, and the
	// repo name repeated on every row is what made the old tab strip overflow.
	const byRepo = Map.groupBy(prs, (link) => link.repo.split("/").pop() ?? "");

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
				<span className="rounded bg-primary/15 px-1.5 py-0.5 normal-case tracking-normal text-primary">
					⑂ Diff
				</span>
				<select
					value={choice ?? ""}
					onChange={(event) => {
						setChoice(event.target.value || null);
						setSelected(0);
					}}
					title="Which diff to show"
					className="rounded-[5px] border border-border bg-card px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-soft-foreground outline-none hover:border-input"
				>
					<option value="">Working tree</option>
					<option value={BRANCH}>Branch commits</option>
					{[...byRepo].map(([repo, links]) => (
						<optgroup key={repo} label={repo}>
							{links.map((link) => {
								const state = prStates?.[link.url]?.state;
								return (
									<option key={link.url} value={link.url}>
										#{link.number}
										{state ? ` · ${state.toLowerCase()}` : ""}
									</option>
								);
							})}
						</optgroup>
					))}
				</select>
				<span title={data?.cwd}>
					{data
						? pr
							? data.source
							: `${data.cwd.split("/").pop()} · ${data.source}`
						: "…"}
				</span>
				{!choice && since && (
					<button
						type="button"
						onClick={() => {
							setShowSince(!showSince);
							setSelected(0);
						}}
						title={
							showSince
								? "Showing only what changed after the last review - click to show all the changes"
								: "Showing all the changes - click to show only what changed after the last review"
						}
						className={`ml-auto normal-case tracking-normal hover:underline ${showSince ? "text-primary" : "text-muted-foreground"}`}
					>
						{showSince ? "◷ since review" : "± all changes"}
					</button>
				)}
				{!pr && (
					<button
						type="button"
						onClick={() => setWholeFile(!wholeFile)}
						title={
							wholeFile
								? "Showing the whole file - click to show only the changes"
								: "Showing only the changes - click to scroll the whole file"
						}
						className={`${!choice && since ? "" : "ml-auto "}normal-case tracking-normal hover:underline ${wholeFile ? "text-primary" : "text-muted-foreground"}`}
					>
						{wholeFile ? "≡ whole file" : "± changes only"}
					</button>
				)}
				<button
					type="button"
					onClick={toggleWrap}
					title={
						wrap
							? "Long lines wrap - click to keep them on one line and scroll sideways"
							: "Long lines run on - click to wrap them"
					}
					className={`${pr ? "ml-auto " : ""}normal-case tracking-normal hover:underline ${wrap ? "text-primary" : "text-muted-foreground"}`}
				>
					{wrap ? "↵ wrap on" : "→ wrap off"}
				</button>
				<button
					type="button"
					onClick={() => void refetch()}
					className="normal-case tracking-normal text-primary hover:underline"
				>
					{isFetching ? "reading…" : "↻ refresh"}
				</button>
				{review.length > 0 && (
					<>
						{unsent.length > 0 && (
							<button
								type="button"
								onClick={() => void sendReview()}
								disabled={write.isPending || snapshot.isPending}
								title="Type every new comment on this diff into the session as one message"
								className="rounded bg-primary px-1.5 py-0.5 normal-case tracking-normal text-primary-foreground hover:opacity-90 disabled:opacity-50"
							>
								➤ send {unsent.length}{" "}
								{unsent.length === 1 ? "comment" : "comments"} to agent
							</button>
						)}
						<button
							type="button"
							onClick={() =>
								saveComments(
									comments.filter((comment) => comment.pr !== choice),
								)
							}
							title="Drop every comment on this diff, sent or not"
							className="normal-case tracking-normal text-muted-foreground hover:underline"
						>
							× clear
						</button>
					</>
				)}
			</div>
			{(error || sendError) && (
				<div className="select-text cursor-text border-b border-border px-4 py-2 text-[12px] text-danger">
					{error?.message ?? sendError}
				</div>
			)}
			<div className="flex min-h-0 flex-1">
				{files.length > 0 && (
					// GitHub's "Files changed" rail: what's in the diff, and a jump to it.
					<div className="flex w-[240px] shrink-0 flex-col border-r border-border bg-background">
						<div className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
							{files.length} {files.length === 1 ? "file" : "files"}{" "}
							<span className="text-success">+{total.added}</span>{" "}
							<span className="text-danger">−{total.removed}</span>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto py-1">
							{files.map((file, index) => {
								const slash = file.path.lastIndexOf("/");
								const binary = file.binary;
								const commented = review.filter(
									(comment) => comment.path === file.path,
								).length;
								return (
									<button
										key={file.path}
										type="button"
										title={
											binary
												? `${file.path}\nBinary file - no text diff to show`
												: file.path
										}
										onClick={() => setSelected(index)}
										className={`flex w-full items-baseline gap-2 px-3 py-[3px] text-left text-[12px] ${
											file === current
												? "bg-secondary text-soft-foreground"
												: "text-soft-foreground hover:bg-card"
										}`}
									>
										<span className="min-w-0 flex-1">
											<span
												className={`block truncate ${binary ? "text-faint-foreground" : ""}`}
											>
												{file.path.slice(slash + 1)}
											</span>
											{slash > 0 && (
												<span className="block truncate text-[10.5px] text-faint-foreground">
													{file.path.slice(0, slash)}
												</span>
											)}
										</span>
										<span className="shrink-0 text-[10.5px] tabular-nums">
											{binary && (
												<span className="rounded-[4px] border border-border px-1 text-muted-foreground">
													binary
												</span>
											)}
											{file.added > 0 && (
												<span className="text-success">+{file.added}</span>
											)}{" "}
											{file.removed > 0 && (
												<span className="text-danger">−{file.removed}</span>
											)}
											{commented > 0 && (
												<span
													title={`${commented} review ${commented === 1 ? "comment" : "comments"} not sent yet`}
													className="ml-1 text-primary"
												>
													✎{commented}
												</span>
											)}
										</span>
									</button>
								);
							})}
						</div>
					</div>
				)}
				<div className="min-h-0 min-w-0 flex-1 overflow-auto bg-background">
					{data?.note && (
						<div className="px-4 py-1.5 text-[11px] text-faint-foreground">
							{data.note}
						</div>
					)}
					{current ? (
						<PatchDiff
							key={`${choice}:${current.path}`}
							patch={current.patch}
							options={{
								...DIFF_POOL_RENDER_OPTIONS,
								diffStyle: "unified",
								overflow: wrap ? "wrap" : "scroll",
								// pierre scrolls each file sideways inside itself (and paint-
								// contains it), so the bar sat under the file's last line.
								// Unclipped, this panel's own box - one screen tall - scrolls.
								unsafeCSS:
									"[data-code] { overflow-x: visible; contain: none; }",
								// GitHub's +: click it for one line, drag it for several.
								enableGutterUtility: true,
								onGutterUtilityClick: (range) =>
									setDraft({
										pr: choice,
										path: current.path,
										...commentTarget(current.patch, current.path, range),
									}),
							}}
							lineAnnotations={annotations}
							renderAnnotation={(annotation) => {
								const id = annotation.metadata?.id;
								if (!id)
									return (
										<DraftBox
											onCancel={() => setDraft(null)}
											onSave={(text) => {
												if (draft)
													saveComments([
														...comments,
														{ ...draft, id: crypto.randomUUID(), text },
													]);
												setDraft(null);
											}}
										/>
									);
								const comment = comments.find((each) => each.id === id);
								return (
									comment && (
										<CommentCard
											comment={comment}
											onDelete={() =>
												saveComments(comments.filter((each) => each.id !== id))
											}
										/>
									)
								);
							}}
						/>
					) : (
						data && (
							<div className="px-4 py-3 text-[12px] text-muted-foreground">
								{pr
									? "This PR has no changes."
									: branch
										? "No commits or edits on this branch since it left its base branch."
										: sinceReview
											? "No changes since the last review was sent."
											: "Nothing from this session - no changes of its own here, and the last commit is not its."}
							</div>
						)
					)}
				</div>
			</div>
		</div>
	);
}

/** The box under the picked lines. The Send hotkey saves, Esc drops it. Its own state, so
 * a keystroke re-renders the box, not the diff. */
function DraftBox({
	onSave,
	onCancel,
}: {
	onSave: (text: string) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState("");
	const sendKeys = useHotkeyDisplay("SUBMIT").text;
	const save = () => text.trim() && onSave(text.trim());
	return (
		<div className="m-2 rounded-md border border-border bg-card p-2 font-sans">
			<textarea
				// biome-ignore lint/a11y/noAutofocus: the box opens because you asked to type in it
				autoFocus
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (isHotkey("SUBMIT", event.nativeEvent)) {
						event.preventDefault();
						save();
					} else if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
				placeholder="What should the agent change here?"
				rows={3}
				className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-[12.5px] text-soft-foreground outline-none focus:border-input"
			/>
			<div className="mt-1 flex justify-end gap-2 text-[11.5px]">
				<button
					type="button"
					onClick={onCancel}
					className="text-muted-foreground hover:underline"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={save}
					disabled={!text.trim()}
					className="rounded bg-primary px-2 py-0.5 text-primary-foreground disabled:opacity-50"
				>
					Add comment {sendKeys}
				</button>
			</div>
		</div>
	);
}

function CommentCard({
	comment,
	onDelete,
}: {
	comment: ReviewComment;
	onDelete: () => void;
}) {
	return (
		<div
			className={`m-2 flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 font-sans text-[12.5px] ${comment.sent ? "opacity-60" : ""}`}
		>
			<div className="min-w-0 flex-1">
				<div className="text-[10.5px] text-faint-foreground">
					{comment.location}
					{comment.sent && (
						<span className="ml-2 rounded-[4px] border border-border px-1 text-muted-foreground">
							✓ sent
						</span>
					)}
				</div>
				<div className="select-text cursor-text whitespace-pre-wrap text-soft-foreground">
					{comment.text}
				</div>
			</div>
			<button
				type="button"
				onClick={onDelete}
				title="Delete this comment"
				className="shrink-0 text-muted-foreground hover:text-danger"
			>
				×
			</button>
		</div>
	);
}
