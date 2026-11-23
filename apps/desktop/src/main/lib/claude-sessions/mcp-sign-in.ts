/**
 * A Claude Code connector (MCP server) that lost its sign-in mid-session. The
 * tool call fails with "MCP server "x" needs you to sign in again (run /mcp
 * to re-authenticate)", and Claude Code files the result with a
 * `toolResultRemedy` of kind `mcp_needs_auth` naming the servers. A session
 * loads its connectors' sign-ins when it starts, so a restart picks up one
 * renewed since.
 */

import { feedLines, type LineReader } from "./lines";

export interface McpSignedOut {
	/** The connectors whose sign-in failed, as Claude Code names them. */
	servers: string[];
	/** When the failing tool call came back, ISO; null when unknown. */
	at: string | null;
}

export function transcriptMcpSignedOut(jsonl: string): McpSignedOut | null {
	const reader = mcpSignedOutReader();
	feedLines(jsonl, reader);
	return reader.result();
}

/** transcriptMcpSignedOut, a line at a time - see LineReader. Keeps the latest. */
export function mcpSignedOutReader(): LineReader & {
	result(): McpSignedOut | null;
} {
	let latest: McpSignedOut | null = null;
	return {
		line(line, entry) {
			if (!line.includes('"mcp_needs_auth"')) return;
			const parsed = entry() as
				| {
						isSidechain?: boolean;
						timestamp?: unknown;
						toolResultRemedy?: { kind?: unknown; servers?: unknown };
				  }
				| null
				| undefined;
			const remedy = parsed?.toolResultRemedy;
			if (!parsed || parsed.isSidechain || remedy?.kind !== "mcp_needs_auth")
				return;
			const servers = Array.isArray(remedy.servers)
				? remedy.servers.filter((s): s is string => typeof s === "string")
				: [];
			latest = {
				servers,
				at: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
			};
		},
		result: () => latest,
	};
}
