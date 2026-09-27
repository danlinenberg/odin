import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
} from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/config";
import { pullRequests } from "./brief";

/**
 * "What did this session actually change?" — delta's diff for the checkout a
 * card runs in.
 *
 * ponytail: delta already emits a rendered diff as ANSI, and the app already
 * ships xterm — so this is a read-only terminal with the bytes written into it,
 * not a diff viewer. No parsing, no highlighting, no virtualised list.
 *
 * The header picks which diff: the working tree or any PR the session opened —
 * a session that shipped five PRs is five diffs, and the working tree is
 * usually none of them.
 */
export function DiffView({
	cwd,
	claudeSessionId,
	workspaceId,
}: {
	/** Null until the session's terminal has mounted — the main process then
	 * falls back to the workspace's own checkout. */
	cwd: string | null;
	/** The conversation in this pane. Claude Code cds between repos without the
	 * shell noticing, so its transcript — not `cwd` — knows where the work is. */
	claudeSessionId: string | null;
	workspaceId: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<{ xterm: XTerm; fit: FitAddon } | null>(null);
	// Delta needs a column count up front (piped, it assumes 80). Start at the
	// default and re-query once xterm has measured the real width.
	const [width, setWidth] = useState(120);
	/** The PR on screen; null is the checkout's own diff. */
	const [pr, setPr] = useState<string | null>(null);
	/** The first line on screen — which file the list marks as current. */
	const [top, setTop] = useState(0);

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
		{ cwd, claudeSessionId, workspaceId, width, pr },
		{ refetchOnWindowFocus: false, retry: false },
	);

	useEffect(() => {
		if (!host.current) return;
		const xterm = new XTerm({
			fontSize: DEFAULT_TERMINAL_FONT_SIZE,
			fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
			// Delta ends lines with \n; nothing here drives a PTY.
			convertEol: true,
			disableStdin: true,
			cursorStyle: "bar",
			cursorInactiveStyle: "none",
			scrollback: 100_000,
			theme: { background: "#0a0a0c", foreground: "#d6d6dc" },
		});
		const fit = new FitAddon();
		xterm.loadAddon(fit);
		xterm.open(host.current);
		fit.fit();
		setWidth(Math.max(xterm.cols, 40));
		term.current = { xterm, fit };
		const scrolled = xterm.onScroll(setTop);

		const observer = new ResizeObserver(() => {
			try {
				fit.fit();
				setWidth(Math.max(xterm.cols, 40));
			} catch {
				// mid-unmount; nothing to size
			}
		});
		observer.observe(host.current);

		return () => {
			observer.disconnect();
			scrolled.dispose();
			term.current = null;
			xterm.dispose();
		};
	}, []);

	useEffect(() => {
		const xterm = term.current?.xterm;
		if (!xterm || !data) return;
		xterm.reset();
		// Writing leaves the viewport at the end of the diff; you read one from
		// the first file down.
		xterm.write(
			data.ansi.trim()
				? data.ansi
				: pr
					? "This PR has no changes."
					: "Nothing from this session — no uncommitted changes, and the last commit here predates it.",
			() => xterm.scrollToTop(),
		);
	}, [data, pr]);

	// Missing until main restarts onto it — then the list just isn't there.
	const files = data?.files ?? [];
	const current = files.findLast((file) => file.line <= top);
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
			<div className="flex items-center gap-2 border-b border-[#25252e] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
				{prs.length > 0 && (
					<select
						value={pr ?? ""}
						onChange={(event) => setPr(event.target.value || null)}
						title="Which diff to show"
						className="rounded-[5px] border border-[#25252e] bg-[#17171d] px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-[#e6e6ee] outline-none hover:border-[#3a3a48]"
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
				{data?.ansi.trim() && !data.delta && (
					<span
						title="brew install git-delta"
						className="normal-case tracking-normal text-[#f5b83d]"
					>
						delta not installed — plain git colours
					</span>
				)}
				<button
					type="button"
					onClick={() => void refetch()}
					className="ml-auto normal-case tracking-normal text-[#a394ff] hover:underline"
				>
					{isFetching ? "reading…" : "↻ refresh"}
				</button>
			</div>
			{error && (
				<div className="select-text cursor-text border-b border-[#25252e] px-4 py-2 text-[12px] text-[#f0647a]">
					{error.message}
				</div>
			)}
			<div className="flex min-h-0 flex-1">
				{files.length > 0 && (
					// GitHub's "Files changed" rail: what's in the diff, and a jump to it.
					<div className="flex w-[240px] shrink-0 flex-col border-r border-[#25252e] bg-[#0d0d10]">
						<div className="border-b border-[#25252e] px-3 py-1.5 text-[11px] text-[#8a8a97]">
							{files.length} {files.length === 1 ? "file" : "files"}{" "}
							<span className="text-[#4ade80]">+{total.added}</span>{" "}
							<span className="text-[#f0647a]">−{total.removed}</span>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto py-1">
							{files.map((file) => {
								const slash = file.path.lastIndexOf("/");
								return (
									<button
										key={`${file.path}:${file.line}`}
										type="button"
										title={file.path}
										onClick={() => term.current?.xterm.scrollToLine(file.line)}
										className={`flex w-full items-baseline gap-2 px-3 py-[3px] text-left text-[12px] ${
											file === current
												? "bg-[#1f1f27] text-[#e6e6ee]"
												: "text-[#b5b5c0] hover:bg-[#17171d]"
										}`}
									>
										<span className="min-w-0 flex-1">
											<span className="block truncate">
												{file.path.slice(slash + 1)}
											</span>
											{slash > 0 && (
												<span className="block truncate text-[10.5px] text-[#6a6a77]">
													{file.path.slice(0, slash)}
												</span>
											)}
										</span>
										<span className="shrink-0 text-[10.5px] tabular-nums">
											{file.added > 0 && (
												<span className="text-[#4ade80]">+{file.added}</span>
											)}{" "}
											{file.removed > 0 && (
												<span className="text-[#f0647a]">−{file.removed}</span>
											)}
										</span>
									</button>
								);
							})}
						</div>
					</div>
				)}
				<div ref={host} className="min-h-0 min-w-0 flex-1 bg-[#0a0a0c] p-2" />
			</div>
		</div>
	);
}
