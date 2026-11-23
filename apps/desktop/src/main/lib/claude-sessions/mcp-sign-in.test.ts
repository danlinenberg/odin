import { expect, test } from "bun:test";
import { transcriptMcpSignedOut } from "./mcp-sign-in";

const failed = (servers: string[], timestamp: string, isSidechain = false) =>
	JSON.stringify({
		type: "user",
		isSidechain,
		timestamp,
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					is_error: true,
					tool_use_id: "toolu_1",
					content: `<error>MCP server "${servers[0]}" needs you to sign in again (run /mcp to re-authenticate)</error>`,
				},
			],
		},
		toolResultRemedy: { kind: "mcp_needs_auth", servers },
	});

test("transcriptMcpSignedOut reads the latest connector that lost its sign-in", () => {
	expect(transcriptMcpSignedOut("")).toBeNull();
	const jsonl = [
		failed(["plugin:chat:chat"], "2026-11-23T09:00:00Z"),
		JSON.stringify({ type: "assistant", message: { content: "ok" } }),
		failed(["claude.ai Docs"], "2026-11-23T09:30:00Z"),
	].join("\n");
	expect(transcriptMcpSignedOut(jsonl)).toEqual({
		servers: ["claude.ai Docs"],
		at: "2026-11-23T09:30:00Z",
	});
});

test("transcriptMcpSignedOut skips subagents, quotes of the kind and broken lines", () => {
	const jsonl = [
		failed(["plugin:chat:chat"], "2026-11-23T09:00:00Z", true),
		// A turn that only quotes the remedy kind.
		JSON.stringify({
			type: "assistant",
			message: { content: 'grep "mcp_needs_auth"' },
		}),
		'{"toolResultRemedy":{"kind":"mcp_needs_auth"',
	].join("\n");
	expect(transcriptMcpSignedOut(jsonl)).toBeNull();
});
