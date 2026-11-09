import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { shell } from "electron";
import { getProcessEnvWithShellPath } from "lib/trpc/routers/workspaces/utils/shell-env";
import * as pty from "node-pty";
import { bundledClaudePath } from "../agent-setup/bundled-claude";
import { asksForCode, claudeOnPath, signInLink } from "./claude-login-output";
import { type ClaudeLogin, parseClaudeLogin } from "./session";

const run = promisify(execFile);

/**
 * A sign-in under way that waits on the user: the page to approve on and,
 * once Claude asks for it, the code that page shows. Null when none.
 */
export interface ClaudeSignInPrompt {
	url: string;
	awaitingCode: boolean;
}
let prompt: ClaudeSignInPrompt | null = null;
let typeCode: ((code: string) => void) | null = null;

export function claudeSignInPrompt(): ClaudeSignInPrompt | null {
	return prompt;
}

/** Types the code from the Claude page at Claude's prompt. */
export function submitClaudeCode(code: string): void {
	if (!typeCode || !prompt?.awaitingCode)
		throw new Error("Claude isn't waiting for a code.");
	typeCode(code.trim());
	prompt = { ...prompt, awaitingCode: false };
}

/**
 * A Claude sign-in of the host's own: `claude auth login` with no window, in
 * a throwaway config folder so this computer's own sign-in stays as it is.
 * Claude opens the browser, you approve, and the login's refresh token comes
 * back here. The host signs in with it once and refreshes on its own after
 * that. Unlike `claude setup-token` (inference only), it lets Claude on the
 * host see the plan, so it offers extra usage at a usage limit.
 *
 * On Windows Claude opens no browser from the pty and waits for the code
 * from the sign-in page instead: Odin opens the page and Settings shows the
 * link and a box for the code (claudeSignInPrompt, submitClaudeCode).
 */
export async function runClaudeLogin(): Promise<ClaudeLogin> {
	const env = await getProcessEnvWithShellPath();
	delete env.ANTHROPIC_API_KEY;
	delete env.CLAUDE_CODE_OAUTH_TOKEN;
	delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
	const claude =
		claudeOnPath(env.PATH ?? env.Path ?? "", process.platform).find(
			existsSync,
		) ?? bundledClaudePath();
	if (!claude) throw new Error("Claude Code is not on this computer.");
	const dir = await mkdtemp(join(tmpdir(), "odin-claude-login-"));
	// Claude names its keychain item after the config folder it signed in for.
	const service = `Claude Code-credentials-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`;
	const asksInTerminal = process.platform === "win32";
	try {
		await new Promise<void>((resolve, reject) => {
			const proc = pty.spawn(claude, ["auth", "login", "--claudeai"], {
				// Wide enough that the sign-in link (about 500 characters) stays on one line.
				cols: asksInTerminal ? 4000 : 500,
				rows: 50,
				env: { ...env, CLAUDE_CONFIG_DIR: dir },
			});
			let output = "";
			let codeSent = false;
			if (asksInTerminal) {
				typeCode = (code) => {
					codeSent = true;
					proc.write(`${code}\r`);
				};
				proc.onData((data) => {
					// Once a code went in, Claude's redraws of its prompt don't ask again.
					if (codeSent) return;
					output = (output + data).slice(-20_000);
					if (!prompt) {
						const url = signInLink(output);
						if (!url) return;
						prompt = { url, awaitingCode: false };
						void shell.openExternal(url).catch(() => {});
					}
					if (!prompt.awaitingCode && asksForCode(output))
						prompt = { ...prompt, awaitingCode: true };
				});
			}
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
		prompt = null;
		typeCode = null;
		await run("security", ["delete-generic-password", "-s", service]).catch(
			() => {},
		);
		await rm(dir, { recursive: true, force: true });
	}
}
