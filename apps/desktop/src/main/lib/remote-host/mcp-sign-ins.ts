import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** One connector's sign-in as Claude Code keeps it under `mcpOAuth`. */
type McpSignIn = Record<string, unknown> & {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
};

/**
 * This computer's Claude Code connector sign-ins (Slack, Notion, any MCP
 * server signed in with OAuth), for sessions on the host: each one's access
 * token, never its refresh token. Two holders of one rotating refresh token
 * would sign each other out, so this computer's Claude Code stays the only
 * one that renews them, and the half-hourly token push brings the new ones.
 * Expired ones and ones never finished are left out.
 */
export function hostMcpSignIns(
	saved: string,
	now = Date.now(),
): Record<string, McpSignIn> {
	let all: Record<string, McpSignIn> = {};
	try {
		all = JSON.parse(saved).mcpOAuth ?? {};
	} catch {
		return {};
	}
	const out: Record<string, McpSignIn> = {};
	for (const [key, entry] of Object.entries(all)) {
		if (!entry?.accessToken) continue;
		if (entry.expiresAt && entry.expiresAt <= now) continue;
		const { refreshToken: _kept, ...rest } = entry;
		out[key] = rest;
	}
	return out;
}

/** Claude Code's saved credentials here: the Keychain on a Mac, else its file. */
export async function localClaudeCredentials(): Promise<string> {
	if (process.platform === "darwin") {
		const saved = await promisify(execFile)(
			"security",
			[
				"find-generic-password",
				"-s",
				"Claude Code-credentials",
				"-a",
				userInfo().username,
				"-w",
			],
			{ timeout: 10_000 },
		).then(
			({ stdout }) => stdout,
			() => "",
		);
		if (saved) return saved;
	}
	return readFile(
		join(homedir(), ".claude", ".credentials.json"),
		"utf8",
	).catch(() => "");
}

/**
 * Run as the host user with the sign-ins on stdin: puts them in the host's
 * ~/.claude/.credentials.json next to its own Claude login, which stays as it
 * is. A connector the host signed in to itself (it has a refresh token there)
 * keeps the host's own sign-in; a new sign-in of the host's own (one with a
 * refresh token, from mcp-host-login) replaces it.
 */
export const MERGE_MCP_SIGN_INS_PY = `import json, os, sys
incoming = json.load(sys.stdin)
path = os.path.expanduser("~/.claude/.credentials.json")
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    data = {}
mine = data.get("mcpOAuth") or {}
for key, entry in incoming.items():
    if entry.get("refreshToken") or not (mine.get(key) or {}).get("refreshToken"):
        mine[key] = entry
data["mcpOAuth"] = mine
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".odin-tmp"
with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
    json.dump(data, f)
os.replace(tmp, path)
`;
