import { describe, expect, test } from "bun:test";
import {
	foldSubagentLine,
	mentionsSubagent,
	parseTaskNotifications,
	subagentCounts,
	subagentList,
	transcriptSubagents,
} from "./subagents";

const T0 = "2026-10-21T10:20:00.000Z";
const T1 = "2026-10-21T10:20:39.000Z";
const T2 = "2026-10-21T10:39:23.000Z";

const launch = (
	id: string,
	input: Record<string, unknown>,
	timestamp = T0,
	name = "Agent",
) =>
	JSON.stringify({
		type: "assistant",
		timestamp,
		message: {
			content: [
				{ type: "text", text: "Spawning." },
				{ type: "tool_use", id, name, input },
			],
		},
	});

const result = (
	id: string,
	content: unknown,
	extra: Record<string, unknown> = {},
	timestamp = T1,
) =>
	JSON.stringify({
		type: "user",
		timestamp,
		message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
		...extra,
	});

const RECEIPT =
	"Async agent launched successfully. (This tool result is internal metadata)\nagentId: a3be929fa6b7cebd8 (internal ID - do not mention to user.)\nThe agent is working in the background.";

const notification = (
	id: string,
	status = "completed",
	result = "Done: PR #12.",
) =>
	[
		"<task-notification>",
		"<task-id>a3be929fa6b7cebd8</task-id>",
		`<tool-use-id>${id}</tool-use-id>`,
		"<output-file>/tmp/x.output</output-file>",
		`<status>${status}</status>`,
		'<summary>Agent "Fix the glitch" completed</summary>',
		`<result>${result}</result>`,
		"<usage><subagent_tokens>160039</subagent_tokens><tool_uses>36</tool_uses><duration_ms>1123913</duration_ms></usage>",
		"</task-notification>",
	].join("\n");

const queued = (prompt: string, timestamp = T2) =>
	JSON.stringify({
		type: "attachment",
		timestamp,
		attachment: { type: "queued_command", prompt },
	});

describe("transcriptSubagents", () => {
	test("an inline agent: launched, then its report is the result", () => {
		const jsonl = [
			launch("t1", {
				description: "Find the diff tab",
				subagent_type: "Explore",
				prompt: "Where is the Diff tab rendered?",
			}),
			result("t1", [{ type: "text", text: "page.tsx:5949" }], {
				toolUseResult: {
					agentId: "a1",
					totalDurationMs: 4200,
					totalTokens: 1500,
					totalToolUseCount: 3,
				},
			}),
		].join("\n");
		expect(transcriptSubagents(jsonl)).toEqual([
			{
				id: "t1",
				agentId: "a1",
				description: "Find the diff tab",
				type: "Explore",
				model: null,
				background: false,
				prompt: "Where is the Diff tab rendered?",
				startedAt: Date.parse(T0),
				endedAt: Date.parse(T1),
				status: "done",
				result: "page.tsx:5949",
				summary: null,
				toolUses: 3,
				tokens: 1500,
				durationMs: 4200,
			},
		]);
	});

	test("a background agent stays running past its launch receipt, until its notification", () => {
		const lines = [
			launch("t1", {
				description: "Fix the glitch",
				subagent_type: "general-purpose",
				prompt: "Fix it.",
				run_in_background: true,
			}),
			result("t1", [{ type: "text", text: RECEIPT }], {
				toolUseResult: {
					isAsync: true,
					status: "async_launched",
					agentId: "a3be929fa6b7cebd8",
					resolvedModel: "claude-fable-5-1",
				},
			}),
		];
		const [running] = transcriptSubagents(lines.join("\n"));
		expect(running).toMatchObject({
			status: "running",
			background: true,
			agentId: "a3be929fa6b7cebd8",
			model: "claude-fable-5-1",
			result: null,
			endedAt: null,
		});
		lines.push(queued(notification("t1")));
		const [done] = transcriptSubagents(lines.join("\n"));
		expect(done).toMatchObject({
			status: "done",
			summary: 'Agent "Fix the glitch" completed',
			result: "Done: PR #12.",
			endedAt: Date.parse(T2),
			tokens: 160039,
			toolUses: 36,
			durationMs: 1123913,
		});
	});

	test("the receipt alone marks a background agent, without the structured result", () => {
		const jsonl = [
			launch("t1", { description: "Build it", prompt: "Build." }),
			result("t1", RECEIPT),
		].join("\n");
		expect(transcriptSubagents(jsonl)[0]).toMatchObject({
			status: "running",
			background: true,
			agentId: "a3be929fa6b7cebd8",
			type: "general-purpose",
		});
	});

	test("a notification delivered as a user turn, once Claude was idle", () => {
		const jsonl = [
			launch("t1", { description: "Build it", prompt: "Build." }),
			result("t1", RECEIPT),
			JSON.stringify({
				type: "user",
				timestamp: T2,
				message: { content: `${notification("t1", "failed", "It crashed.")}` },
			}),
		].join("\n");
		expect(transcriptSubagents(jsonl)[0]).toMatchObject({
			status: "failed",
			result: "It crashed.",
			endedAt: Date.parse(T2),
		});
	});

	test("an errored inline result is a failure", () => {
		const jsonl = [
			launch("t1", { description: "Build it", prompt: "Build." }),
			JSON.stringify({
				type: "user",
				timestamp: T1,
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							is_error: true,
							content: "Agent was killed",
						},
					],
				},
			}),
		].join("\n");
		expect(transcriptSubagents(jsonl)[0]).toMatchObject({
			status: "failed",
			result: "Agent was killed",
		});
	});

	test("a notification for a background Bash command is not an agent", () => {
		const jsonl = [
			launch("t1", { description: "Build it", prompt: "Build." }),
			queued(notification("bash-9")),
		].join("\n");
		expect(transcriptSubagents(jsonl)).toHaveLength(1);
		expect(transcriptSubagents(jsonl)[0]?.status).toBe("running");
	});

	test("older transcripts call the tool Task; sidechain lines are skipped", () => {
		const jsonl = [
			launch("t1", { description: "Old style", prompt: "Go." }, T0, "Task"),
			JSON.stringify({
				type: "assistant",
				isSidechain: true,
				message: {
					content: [{ type: "tool_use", id: "t2", name: "Agent", input: {} }],
				},
			}),
		].join("\n");
		expect(transcriptSubagents(jsonl).map((agent) => agent.id)).toEqual(["t1"]);
	});

	test("newest launch first, and the counts", () => {
		const jsonl = [
			launch("t1", { description: "First", prompt: "." }, T0),
			launch("t2", { description: "Second", prompt: "." }, T1),
			result("t1", "ok"),
		].join("\n");
		const agents = transcriptSubagents(jsonl);
		expect(agents.map((agent) => agent.description)).toEqual([
			"Second",
			"First",
		]);
		expect(subagentCounts(agents)).toEqual({ running: 1, done: 1, failed: 0 });
	});

	test("ignores garbage and lines that can't matter", () => {
		const agents = new Map();
		expect(foldSubagentLine(agents, "")).toBe(false);
		expect(foldSubagentLine(agents, "{not json")).toBe(false);
		expect(
			foldSubagentLine(
				agents,
				JSON.stringify({ type: "ai-title", aiTitle: "x" }),
			),
		).toBe(false);
		expect(subagentList(agents)).toEqual([]);
		expect(
			mentionsSubagent('{"type":"assistant","message":{"content":[]}}'),
		).toBe(false);
		expect(mentionsSubagent('{"type":"tool_use","name":"Agent"}')).toBe(true);
	});
});

describe("parseTaskNotifications", () => {
	test("reads every block and tolerates missing tags", () => {
		const message = `${notification("t1")}\n${notification("t2", "failed")}`;
		expect(
			parseTaskNotifications(message).map((n) => [n.toolUseId, n.status]),
		).toEqual([
			["t1", "completed"],
			["t2", "failed"],
		]);
		expect(
			parseTaskNotifications(
				"<task-notification><tool-use-id>t3</tool-use-id></task-notification>",
			),
		).toEqual([
			{
				toolUseId: "t3",
				taskId: null,
				status: "completed",
				summary: null,
				result: null,
				tokens: null,
				toolUses: null,
				durationMs: null,
			},
		]);
		expect(
			parseTaskNotifications("<task-notification></task-notification>"),
		).toEqual([]);
	});
});
