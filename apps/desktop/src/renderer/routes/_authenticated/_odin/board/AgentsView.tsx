import { cn } from "@odin/ui/utils";
import { useEffect, useState } from "react";
import { MarkdownRenderer } from "renderer/components/MarkdownRenderer";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { type Subagent, subagentCounts } from "shared/subagents";
import { elapsedLabel as agoLabel } from "./brief";
import { elapsedLabel } from "./ChatView";

/** How often to ask again while the session is alive: the panel, the drawer's button, a card's pill. */
const PANEL_MS = 2_000;
const BUTTON_MS = 5_000;
const PILL_MS = 15_000;

/**
 * The session's subagents, from the main process's fold of its transcript.
 * One cache entry per session, shared by the panel, the drawer's button and
 * the card's pill; react-query polls at the fastest interval asked for.
 */
function useSubagents(sessionId: string | null, everyMs: number | false) {
	return electronTrpc.terminal.claudeSubagents.useQuery(
		{ sessionId: sessionId ?? "" },
		{
			enabled: !!sessionId,
			retry: false,
			staleTime: 1_000,
			refetchInterval: everyMs,
		},
	);
}

/**
 * What a row says about an agent. "Running" needs the session alive: an
 * agent that never reported because Claude was killed is stopped, not out.
 */
function stateOf(agent: Subagent, alive: boolean) {
	if (agent.status === "running") return alive ? "running" : "stopped";
	return agent.status;
}

const DOT: Record<ReturnType<typeof stateOf>, string> = {
	running: "animate-pulse text-working",
	stopped: "text-faint-foreground",
	done: "text-success",
	failed: "text-danger",
};

/**
 * "⋔ Agents" in the drawer's title row, beside Diff: how many subagents the
 * session has out, and the way to the panel. Hidden until the session has
 * launched one, so a session that never fans out keeps a clean header.
 */
export function SubagentsButton({
	sessionId,
	alive,
	open,
	onClick,
}: {
	sessionId: string | null;
	/** The session's PTY is up - its running agents really are running. */
	alive: boolean;
	open: boolean;
	onClick: () => void;
}) {
	const { data } = useSubagents(sessionId, alive ? BUTTON_MS : false);
	const agents = data ?? [];
	if (agents.length === 0 && !open) return null;
	const running = alive ? subagentCounts(agents).running : 0;
	return (
		<button
			type="button"
			title={
				running
					? `${running} ${running === 1 ? "subagent is" : "subagents are"} working for this session - click to see them`
					: `The ${agents.length === 1 ? "subagent" : `${agents.length} subagents`} this session launched`
			}
			onClick={onClick}
			className={cn(
				"flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold",
				open
					? "bg-primary/15 text-primary"
					: "bg-secondary text-muted-foreground hover:text-foreground",
			)}
		>
			⋔ Agents
			{running > 0 ? (
				<span className="flex items-center gap-1 text-working">
					<span className="size-1.5 animate-pulse rounded-full bg-working" />
					{running}
				</span>
			) : agents.length > 0 ? (
				<span className="text-faint-foreground">{agents.length}</span>
			) : null}
		</button>
	);
}

/**
 * "⋔ 2 agents" on a card while its session is mid-turn with subagents out -
 * the fact you scan the board for. A parked session's unfinished agents
 * aren't working, so the pill goes with the turn.
 */
export function SubagentsPill({
	sessionId,
	live,
}: {
	sessionId: string | null;
	/** The card is Working: the only time an agent can be out. */
	live: boolean;
}) {
	const { data } = useSubagents(sessionId, live ? PILL_MS : false);
	const running = live && data ? subagentCounts(data).running : 0;
	if (!running) return null;
	return (
		<span
			title={`${running} ${running === 1 ? "subagent is" : "subagents are"} working for this session`}
			className="inline-flex items-center gap-1 font-medium text-working"
		>
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-working" />
			{running} {running === 1 ? "agent" : "agents"}
		</span>
	);
}

/**
 * "What has this session fanned out to?" - every subagent it launched, newest
 * first, with what it was asked and what it came back with. Takes the
 * terminal's place like Diff does: you read it instead of the session.
 *
 * Read off the parent's transcript, so a remote host's session shows the
 * same as a local one - see `shared/subagents`.
 */
export function AgentsView({
	sessionId,
	alive,
}: {
	sessionId: string | null;
	alive: boolean;
}) {
	const { data, error, isFetching, refetch } = useSubagents(
		sessionId,
		alive ? PANEL_MS : false,
	);
	const agents = data ?? [];
	const counts = subagentCounts(agents);
	const running = alive ? counts.running : 0;
	const stopped = counts.running - running;
	/** Rows opened to their prompt and report. */
	const [openIds, setOpenIds] = useState<string[]>([]);
	// Running durations tick without a refetch to carry them.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [running]);

	const toggle = (id: string) =>
		setOpenIds((ids) =>
			ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id],
		);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
				<span className="rounded bg-primary/15 px-1.5 py-0.5 normal-case tracking-normal text-primary">
					⋔ Agents
				</span>
				<span className="normal-case tracking-normal">
					{agents.length === 0
						? "none yet"
						: [
								running && `${running} running`,
								counts.done && `${counts.done} done`,
								counts.failed && `${counts.failed} failed`,
								stopped && `${stopped} stopped`,
							]
								.filter(Boolean)
								.join(" · ")}
				</span>
				<button
					type="button"
					onClick={() => void refetch()}
					className="ml-auto normal-case tracking-normal text-primary hover:underline"
				>
					{isFetching ? "reading…" : "↻ refresh"}
				</button>
			</div>
			{error && (
				<div className="select-text cursor-text border-b border-border px-4 py-2 text-[12px] text-danger">
					{error.message}
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{!sessionId ? (
					<Empty>This session has no conversation to read yet.</Empty>
				) : agents.length === 0 && data ? (
					<Empty>
						This session hasn't launched a subagent. When Claude hands work to
						one (the Agent tool), it shows here as it runs.
					</Empty>
				) : (
					agents.map((agent) => (
						<AgentRow
							key={agent.id}
							agent={agent}
							state={stateOf(agent, alive)}
							open={openIds.includes(agent.id)}
							onToggle={() => toggle(agent.id)}
							now={now}
						/>
					))
				)}
			</div>
		</div>
	);
}

function Empty({ children }: { children: React.ReactNode }) {
	return (
		<div className="px-4 py-6 text-[12.5px] text-muted-foreground">
			{children}
		</div>
	);
}

const modelLabel = (model: string) =>
	model.replace(/^(us\.anthropic\.)?claude-/, "");

function AgentRow({
	agent,
	state,
	open,
	onToggle,
	now,
}: {
	agent: Subagent;
	state: ReturnType<typeof stateOf>;
	open: boolean;
	onToggle: () => void;
	now: number;
}) {
	const started = agent.startedAt;
	const ranFor =
		agent.durationMs ??
		(started && agent.endedAt ? agent.endedAt - started : null);
	const timing =
		state === "running" && started
			? `running ${elapsedLabel(now - started)}`
			: state === "stopped"
				? "stopped before it reported"
				: ranFor !== null
					? `ran ${elapsedLabel(ranFor)}`
					: null;
	const meta = [
		agent.type,
		agent.model && modelLabel(agent.model),
		agent.background ? "in the background" : null,
		started && `started ${agoLabel(started, now)} ago`,
		agent.toolUses !== null && `${agent.toolUses} tool calls`,
		agent.tokens !== null && `${Math.round(agent.tokens / 1000)}k tokens`,
	].filter(Boolean);
	return (
		<div className="border-b border-border">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-card"
			>
				<span className={cn("mt-[3px] text-[10px] leading-none", DOT[state])}>
					●
				</span>
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline gap-2">
						<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
							{agent.description || agent.type}
						</span>
						{timing && (
							<span
								className={cn(
									"shrink-0 text-[11px]",
									state === "running"
										? "text-working"
										: state === "failed"
											? "text-danger"
											: "text-muted-foreground",
								)}
							>
								{state === "failed" ? `failed · ${timing}` : timing}
							</span>
						)}
					</span>
					<span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
						{meta.join(" · ")}
					</span>
					{!open && agent.summary && (
						<span className="mt-0.5 block truncate text-[12px] text-soft-foreground">
							{agent.summary}
						</span>
					)}
				</span>
				<span className="mt-0.5 shrink-0 text-[11px] text-faint-foreground">
					{open ? "▾" : "▸"}
				</span>
			</button>
			{open && (
				<div className="flex flex-col gap-3 px-4 pb-4 pl-[38px]">
					<section>
						<div className="mb-1 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
							Asked to
						</div>
						<pre className="max-h-[40vh] select-text cursor-text overflow-y-auto whitespace-pre-wrap rounded-md bg-secondary px-3 py-2 font-sans text-[12px] text-soft-foreground">
							{agent.prompt || "(no prompt recorded)"}
						</pre>
					</section>
					<section>
						<div className="mb-1 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
							{state === "running"
								? "Report"
								: state === "failed"
									? "Failed with"
									: "Reported"}
						</div>
						{agent.result ? (
							<MarkdownRenderer
								content={agent.result}
								style="default"
								allowHtml={false}
								className="rounded-md bg-secondary px-3 py-2 text-[12.5px] [&_li]:whitespace-pre-wrap [&_p]:whitespace-pre-wrap"
							/>
						) : (
							<div className="text-[12px] text-muted-foreground">
								{state === "running"
									? "Nothing yet - it reports when it finishes."
									: "It never reported."}
							</div>
						)}
					</section>
				</div>
			)}
		</div>
	);
}
