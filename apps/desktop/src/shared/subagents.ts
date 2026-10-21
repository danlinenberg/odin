/**
 * The subagents a Claude Code session launched, read off its own transcript.
 *
 * A subagent is an `Agent` tool call (`Task` in older Claude Code). Its
 * transcript lives in `<session>/subagents/agent-<id>.jsonl` beside the
 * parent's, but that folder isn't mirrored for a remote host's session and
 * the parent's transcript already tells the whole story:
 *
 * - the assistant's `tool_use` block launches it, with the description and
 *   prompt Claude gave it;
 * - its `tool_result` is the final report for an inline agent, or the launch
 *   receipt ("Async agent launched …") for a background one;
 * - a background agent's report arrives later as a `<task-notification>`,
 *   queued as a command attachment while Claude works or as a user turn once
 *   it is idle, naming the tool call it answers.
 *
 * Both the main process (the whole file, incrementally) and the renderer (its
 * live tail) can fold lines through here, so the two agree.
 */

export type SubagentStatus = "running" | "done" | "failed";

export interface Subagent {
	/** The Agent tool call's id - what a task notification answers to. */
	id: string;
	/** Claude's own id for the agent, once known (a background launch names it). */
	agentId: string | null;
	/** The 3-5 word label Claude gave the task. */
	description: string;
	/** `subagent_type`: general-purpose, Explore, a custom agent's name. */
	type: string;
	model: string | null;
	/** Launched with `run_in_background`: Claude went on while it worked. */
	background: boolean;
	prompt: string;
	/** ms; null when the launching line had no timestamp. */
	startedAt: number | null;
	endedAt: number | null;
	status: SubagentStatus;
	/** The agent's final report, or what it failed with. */
	result: string | null;
	/** The one-line summary a task notification carries. */
	summary: string | null;
	toolUses: number | null;
	tokens: number | null;
	durationMs: number | null;
}

const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** Whether a transcript line can change the fold - a cheap test before JSON.parse. */
export function mentionsSubagent(line: string): boolean {
	return (
		(line.includes('"tool_use"') &&
			(line.includes('"Agent"') || line.includes('"Task"'))) ||
		line.includes('"tool_result"') ||
		line.includes("<task-notification>")
	);
}

type Block = {
	type?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
	text?: string;
};

type Entry = {
	type?: string;
	isSidechain?: boolean;
	timestamp?: string;
	message?: { content?: unknown };
	attachment?: { type?: string; prompt?: unknown };
	/** Claude Code's structured copy of a tool's result, beside the message. */
	toolUseResult?: unknown;
};

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: Block) => (block?.type === "text" ? (block.text ?? "") : ""))
		.join("\n");
}

const str = (value: unknown): string | null =>
	typeof value === "string" && value ? value : null;
const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

function timeOf(entry: Entry): number | null {
	const at = Date.parse(entry.timestamp ?? "");
	return Number.isFinite(at) ? at : null;
}

/** One `<task-notification>` block, as Claude Code writes it. */
export interface TaskNotification {
	toolUseId: string;
	taskId: string | null;
	status: string;
	summary: string | null;
	result: string | null;
	tokens: number | null;
	toolUses: number | null;
	durationMs: number | null;
}

const tag = (block: string, name: string): string | null => {
	const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return match?.[1]?.trim() ?? null;
};

/** Every task notification in a message, in order. */
export function parseTaskNotifications(message: string): TaskNotification[] {
	const found: TaskNotification[] = [];
	for (const [block] of message.matchAll(
		/<task-notification>[\s\S]*?<\/task-notification>/g,
	)) {
		const toolUseId = tag(block, "tool-use-id");
		if (!toolUseId) continue;
		const usage = tag(block, "usage") ?? "";
		found.push({
			toolUseId,
			taskId: tag(block, "task-id"),
			status: tag(block, "status") ?? "completed",
			summary: tag(block, "summary"),
			result: tag(block, "result"),
			tokens: num(Number(tag(usage, "subagent_tokens") ?? Number.NaN)),
			toolUses: num(Number(tag(usage, "tool_uses") ?? Number.NaN)),
			durationMs: num(Number(tag(usage, "duration_ms") ?? Number.NaN)),
		});
	}
	return found;
}

/**
 * Fold one parsed transcript line into the agents by tool call id. Returns
 * whether anything changed. Lines of the subagents themselves (sidechains)
 * never reach the parent's file, but are skipped all the same.
 */
export function foldSubagent(
	agents: Map<string, Subagent>,
	entry: Entry,
): boolean {
	if (entry.isSidechain) return false;
	let changed = false;
	if (entry.type === "assistant") {
		const content = entry.message?.content;
		if (!Array.isArray(content)) return false;
		for (const block of content as Block[]) {
			if (
				block?.type !== "tool_use" ||
				!block.id ||
				!AGENT_TOOLS.has(block.name ?? "") ||
				agents.has(block.id)
			)
				continue;
			const input = block.input ?? {};
			agents.set(block.id, {
				id: block.id,
				agentId: null,
				description: str(input.description) ?? "",
				type: str(input.subagent_type) ?? "general-purpose",
				model: str(input.model),
				background: input.run_in_background === true,
				prompt: str(input.prompt) ?? "",
				startedAt: timeOf(entry),
				endedAt: null,
				status: "running",
				result: null,
				summary: null,
				toolUses: null,
				tokens: null,
				durationMs: null,
			});
			changed = true;
		}
		return changed;
	}
	if (entry.type === "user") {
		const content = entry.message?.content;
		if (Array.isArray(content)) {
			for (const block of content as Block[]) {
				if (block?.type !== "tool_result" || !block.tool_use_id) continue;
				const agent = agents.get(block.tool_use_id);
				if (!agent) continue;
				changed = true;
				const report = text(block.content);
				const meta = (
					entry.toolUseResult && typeof entry.toolUseResult === "object"
						? entry.toolUseResult
						: {}
				) as Record<string, unknown>;
				agent.agentId ??=
					str(meta.agentId) ?? report.match(/agentId: (\w+)/)?.[1] ?? null;
				agent.model ??= str(meta.resolvedModel);
				// A background launch answers at once with a receipt, not a report.
				if (
					meta.status === "async_launched" ||
					report.startsWith("Async agent launched")
				) {
					agent.background = true;
					continue;
				}
				agent.status = block.is_error ? "failed" : "done";
				agent.result = report || null;
				agent.endedAt = timeOf(entry);
				agent.toolUses ??= num(meta.totalToolUseCount);
				agent.tokens ??= num(meta.totalTokens);
				agent.durationMs ??= num(meta.totalDurationMs);
			}
		}
		// A notification delivered as a turn, once Claude was idle.
		return applyNotifications(agents, text(content), timeOf(entry)) || changed;
	}
	if (
		entry.type === "attachment" &&
		entry.attachment?.type === "queued_command"
	)
		return applyNotifications(
			agents,
			text(entry.attachment.prompt),
			timeOf(entry),
		);
	return false;
}

function applyNotifications(
	agents: Map<string, Subagent>,
	message: string,
	at: number | null,
): boolean {
	if (!message.includes("<task-notification>")) return false;
	let changed = false;
	for (const notice of parseTaskNotifications(message)) {
		const agent = agents.get(notice.toolUseId);
		if (!agent) continue; // a background Bash command's, not an agent's
		changed = true;
		agent.agentId ??= notice.taskId;
		agent.background = true;
		agent.status = notice.status === "completed" ? "done" : "failed";
		agent.summary = notice.summary;
		agent.result = notice.result;
		agent.endedAt = at;
		agent.tokens = notice.tokens ?? agent.tokens;
		agent.toolUses = notice.toolUses ?? agent.toolUses;
		agent.durationMs = notice.durationMs ?? agent.durationMs;
	}
	return changed;
}

/** Fold a raw JSONL line; a line that can't matter costs a string scan, not a parse. */
export function foldSubagentLine(
	agents: Map<string, Subagent>,
	line: string,
): boolean {
	if (!line || !mentionsSubagent(line)) return false;
	let entry: Entry;
	try {
		entry = JSON.parse(line) as Entry;
	} catch {
		return false; // a truncated tail
	}
	return foldSubagent(agents, entry);
}

/** The whole transcript's agents, newest launch first. */
export function transcriptSubagents(jsonl: string): Subagent[] {
	const agents = new Map<string, Subagent>();
	for (const line of jsonl.split("\n")) foldSubagentLine(agents, line);
	return subagentList(agents);
}

/** Newest launch first - the one you're waiting on is usually the latest. */
export function subagentList(agents: Map<string, Subagent>): Subagent[] {
	return [...agents.values()].reverse();
}

/** How many are still out, done and failed - the header's numbers. */
export function subagentCounts(agents: Subagent[]): {
	running: number;
	done: number;
	failed: number;
} {
	const counts = { running: 0, done: 0, failed: 0 };
	for (const agent of agents) counts[agent.status]++;
	return counts;
}
