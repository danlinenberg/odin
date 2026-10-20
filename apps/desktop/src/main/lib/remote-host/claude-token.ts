import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { getProcessEnvWithShellPath } from "lib/trpc/routers/workspaces/utils/shell-env";
import * as pty from "node-pty";
import { bundledClaudePath } from "../agent-setup/bundled-claude";
import { type ClaudeLogin, parseClaudeLogin } from "./session";

const run = promisify(execFile);

/**
 * A Claude sign-in of the host's own: `claude auth login` with no window, in
 * a throwaway config folder so this computer's own sign-in stays as it is.
 * Claude opens the browser, you approve, and the login's refresh token comes
 * back here. The host signs in with it once and refreshes on its own after
 * that. Unlike `claude setup-token` (inference only), it lets Claude on the
 * host see the plan, so it offers extra usage at a usage limit.
 */
export async function runClaudeLogin(): Promise<ClaudeLogin> {
	const env = await getProcessEnvWithShellPath();
	delete env.ANTHROPIC_API_KEY;
	delete env.CLAUDE_CODE_OAUTH_TOKEN;
	delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
	const claude =
		(env.PATH ?? "")
			.split(delimiter)
			.map((dir) => join(dir, "claude"))
			.find(existsSync) ?? bundledClaudePath();
	if (!claude) throw new Error("Claude Code is not on this computer.");
	const dir = await mkdtemp(join(tmpdir(), "odin-claude-login-"));
	// Claude names its keychain item after the config folder it signed in for.
	const service = `Claude Code-credentials-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`;
	try {
		await new Promise<void>((resolve, reject) => {
			const proc = pty.spawn(claude, ["auth", "login", "--claudeai"], {
				cols: 500,
				rows: 50,
				env: { ...env, CLAUDE_CONFIG_DIR: dir },
			});
			const timer = setTimeout(() => {
				proc.kill();
				reject(new Error("No approval in the browser within 5 minutes."));
			}, 5 * 60_000);
			proc.onExit(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		const saved = await run("security", [
			"find-generic-password",
			"-s",
			service,
			"-a",
			userInfo().username,
			"-w",
		])
			.then(({ stdout }) => stdout)
			.catch(() => {
				const file = join(dir, ".credentials.json");
				return readFile(file, "utf8").catch(() => "");
			});
		const login = parseClaudeLogin(saved, randomUUID());
		if (!login) throw new Error("claude auth login ended without a sign-in.");
		return login;
	} finally {
		await run("security", ["delete-generic-password", "-s", service]).catch(
			() => {},
		);
		await rm(dir, { recursive: true, force: true });
	}
}
