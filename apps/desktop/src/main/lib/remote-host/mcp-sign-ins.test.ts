import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostMcpSignIns, MERGE_MCP_SIGN_INS_PY } from "./mcp-sign-ins";

test("connector sign-ins go to the host without refresh tokens, next to its own Claude login", () => {
	const saved = JSON.stringify({
		claudeAiOauth: { refreshToken: "mac-login" },
		mcpOAuth: {
			"plugin:slack:slack|a": {
				accessToken: "s1",
				refreshToken: "r1",
				expiresAt: 2000,
			},
			"plugin:Notion:notion|b": { accessToken: "n1", expiresAt: 500 },
			"plugin:x:x|c": { accessToken: "" },
			"plugin:y:y|d": { accessToken: "y1", refreshToken: "r2" },
		},
	});
	const sent = hostMcpSignIns(saved, 1000);
	// No refresh token, nothing expired, nothing never finished.
	expect(sent).toEqual({
		"plugin:slack:slack|a": { accessToken: "s1", expiresAt: 2000 },
		"plugin:y:y|d": { accessToken: "y1" },
	});
	expect(hostMcpSignIns("not json")).toEqual({});

	const home = mkdtempSync(join(tmpdir(), "odin-mcp-"));
	const file = join(home, ".claude", ".credentials.json");
	mkdirSync(join(home, ".claude"));
	writeFileSync(
		file,
		JSON.stringify({
			claudeAiOauth: { refreshToken: "host-login" },
			mcpOAuth: {
				"plugin:y:y|d": { accessToken: "own", refreshToken: "own-r" },
			},
		}),
	);
	execFileSync(
		"sh",
		["-c", `HOME=${home} python3 -c "$0"`, MERGE_MCP_SIGN_INS_PY],
		{
			input: JSON.stringify(sent),
		},
	);
	const merged = JSON.parse(readFileSync(file, "utf8"));
	expect(merged.claudeAiOauth.refreshToken).toBe("host-login");
	expect(merged.mcpOAuth["plugin:slack:slack|a"].accessToken).toBe("s1");
	// A connector the host signed in to itself keeps the host's sign-in.
	expect(merged.mcpOAuth["plugin:y:y|d"].accessToken).toBe("own");
	expect(statSync(file).mode & 0o777).toBe(0o600);
});
