import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
} from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/config";
import { pullRequests } from "./brief";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point
const ESCAPES = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * "What did this session actually change?" - delta's diff for the checkout a
 * card runs in.
 *
 * ponytail: delta already emits a rendered diff as ANSI, and the app already
 * ships xterm - so this is a read-only terminal with the bytes written into it,
 * not a diff viewer. No parsing, no highlighting, no virtualised list.
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
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<{ xterm: XTerm; fit: FitAddon } | null>(null);
	// Delta needs a column count up front (piped, it assumes 80). Start at the
	// default and re-query once xterm has measured the real width.
	const [width, setWidth] = useState(120);
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
	/** Columns the longest line on screen needs; 0 while wrapping. xterm only
	 * scrolls down, so unwrapped it is made this wide and its box scrolls. */
	const longest = useRef(0);

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
		{ cwd, claudeSessionId, workspaceId, width, pr, wrap },
		{
			refetchOnWindowFocus: false,
			retry: false,
			// Keep the last diff while a new width re-renders. Dropping it hid the
			// file list, which widened the terminal, which changed the width again -
			// the panel flickered between renders and never settled.
			placeholderData: keepPreviousData,
		},
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
			theme: { background: "#0e0e11", foreground: "#c9c9d3" },
		});
		const fit = new FitAddon();
		xterm.loadAddon(fit);
		xterm.open(host.current);
		fit.fit();
		setWidth(Math.max(xterm.cols, 40));
		term.current = { xterm, fit };

		const observer = new ResizeObserver(() => {
			try {
				fit.fit();
				setWidth(Math.max(xterm.cols, 40));
				if (longest.current > xterm.cols)
					xterm.resize(longest.current, xterm.rows);
			} catch {
				// mid-unmount; nothing to size
			}
		});
		observer.observe(host.current);

		return () => {
			observer.disconnect();
			term.current = null;
			xterm.dispose();
		};
	}, []);

	// Missing until main restarts onto it - then the list just isn't there.
	const files = data?.files ?? [];
	const current = files[Math.min(selected, files.length - 1)];

	useEffect(() => {
		const xterm = term.current?.xterm;
		if (!xterm || !data) return;
		// Only the selected file's lines; the first file also carries whatever
		// precedes it (a commit header, a note).
		const index = current ? files.indexOf(current) : -1;
		const text =
			index < 0
				? data.ansi
				: data.ansi
						.split("\n")
						.slice(index === 0 ? 0 : current.line, files[index + 1]?.line)
						.join("\n");
		// Fit first, then widen to the longest line - before writing, so xterm
		// never breaks a line it is about to hold.
		term.current?.fit.fit();
		longest.current = wrap
			? 0
			: text
					.split("\n")
					.reduce(
						(most, line) =>
							Math.max(most, Array.from(line.replace(ESCAPES, "")).length),
						0,
					);
		if (longest.current > xterm.cols) xterm.resize(longest.current, xterm.rows);
		// Its scrollbar sits at the box's first right edge and slides into the
		// code once you scroll sideways; the wheel still scrolls down.
		xterm.options.scrollbar = { showScrollbar: wrap };
		xterm.reset();
		// Writing leaves the viewport at the end; you read a file from the top.
		xterm.write(
			data.ansi.trim()
				? text
				: pr
					? "This PR has no changes."
					: "Nothing from this session - no uncommitted changes, and the last commit here predates it.",
			() => xterm.scrollToTop(),
		);
	}, [data, pr, current, files, wrap]);
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
				{data?.ansi.trim() && !data.delta && (
					<span
						title="brew install git-delta"
						className="normal-case tracking-normal text-attention"
					>
						delta not installed - plain git colours
					</span>
				)}
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
								// `binary` is missing until main restarts onto it; nothing
								// added or removed is the same tell for these files.
								const binary = file.binary ?? file.added + file.removed === 0;
								return (
									<button
										key={`${file.path}:${file.line}`}
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
				<div
					ref={host}
					className="min-h-0 min-w-0 flex-1 overflow-x-auto bg-background p-2"
				/>
			</div>
		</div>
	);
}
