import { PatchDiff } from "@pierre/diffs/react";
import { keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { DIFF_POOL_RENDER_OPTIONS } from "renderer/screens/main/components/WorkspaceView/utils/code-theme/diff-render-options";
import { pullRequests } from "./brief";

/**
 * "What did this session actually change?" - the diff for the checkout a card
 * runs in, one file at a time, rendered by @pierre/diffs (the app's own diff
 * engine, themed by the worker pool) - nothing to install on the machine.
 *
 * The header picks which diff: the working tree or any PR the session opened -
 * a session that shipped five PRs is five diffs, and the working tree is
 * usually none of them.
 */
export function DiffView({
	cwd,
	claudeSessionId,
	workspaceId,
}: {
	/** Null until the session's terminal has mounted - the main process then
	 * falls back to the workspace's own checkout. */
	cwd: string | null;
	/** The conversation in this pane. Claude Code cds between repos without the
	 * shell noticing, so its transcript - not `cwd` - knows where the work is. */
	claudeSessionId: string | null;
	workspaceId: string;
}) {
	/** The PR on screen; null is the checkout's own diff. */
	const [pr, setPr] = useState<string | null>(null);
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

	const { data, error, isFetching, refetch } = electronTrpc.repos.diff.useQuery(
		{ cwd, claudeSessionId, workspaceId, pr },
		{
			refetchOnWindowFocus: false,
			retry: false,
			// Keep the last diff on screen while a refresh reads the next one.
			placeholderData: keepPreviousData,
		},
	);

	const files = data?.files ?? [];
	const current = files[Math.min(selected, files.length - 1)];

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
				{prs.length > 0 && (
					<select
						value={pr ?? ""}
						onChange={(event) => {
							setPr(event.target.value || null);
							setSelected(0);
						}}
						title="Which diff to show"
						className="rounded-[5px] border border-border bg-card px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-soft-foreground outline-none hover:border-input"
					>
						<option value="">Working tree</option>
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
				)}
				<span title={data?.cwd}>
					Diff ·{" "}
					{data
						? pr
							? data.source
							: `${data.cwd.split("/").pop()} · ${data.source}`
						: "…"}
				</span>
				<button
					type="button"
					onClick={toggleWrap}
					title={
						wrap
							? "Long lines wrap - click to keep them on one line and scroll sideways"
							: "Long lines run on - click to wrap them"
					}
					className={`ml-auto normal-case tracking-normal hover:underline ${wrap ? "text-primary" : "text-muted-foreground"}`}
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
			</div>
			{error && (
				<div className="select-text cursor-text border-b border-border px-4 py-2 text-[12px] text-danger">
					{error.message}
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
							key={`${pr}:${current.path}`}
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
							}}
						/>
					) : (
						data && (
							<div className="px-4 py-3 text-[12px] text-muted-foreground">
								{pr
									? "This PR has no changes."
									: "Nothing from this session - no uncommitted changes, and the last commit here predates it."}
							</div>
						)
					)}
				</div>
			</div>
		</div>
	);
}
