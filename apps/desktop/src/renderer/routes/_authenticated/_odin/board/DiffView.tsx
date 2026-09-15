import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
} from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/config";

/**
 * "What did this session actually change?" — delta's diff for the checkout a
 * card runs in.
 *
 * ponytail: delta already emits a rendered diff as ANSI, and the app already
 * ships xterm — so this is a read-only terminal with the bytes written into it,
 * not a diff viewer. No parsing, no highlighting, no virtualised list.
 */
export function DiffView({
	cwd,
	workspaceId,
}: {
	/** Null until the session's terminal has mounted — the main process then
	 * falls back to the workspace's own checkout. */
	cwd: string | null;
	workspaceId: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<{ xterm: XTerm; fit: FitAddon } | null>(null);
	// Delta needs a column count up front (piped, it assumes 80). Start at the
	// default and re-query once xterm has measured the real width.
	const [width, setWidth] = useState(120);

	const { data, error, isFetching, refetch } = electronTrpc.repos.diff.useQuery(
		{ cwd, workspaceId, width },
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
			data.ansi.trim() ? data.ansi : "No changes in this checkout.",
			() => xterm.scrollToTop(),
		);
	}, [data]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-2 border-b border-[#25252e] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
				<span>Diff · {data?.source ?? "…"}</span>
				{data && !data.delta && (
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
			<div ref={host} className="min-h-0 flex-1 bg-[#0a0a0c] p-2" />
		</div>
	);
}
