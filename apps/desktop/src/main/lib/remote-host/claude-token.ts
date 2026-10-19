import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getProcessEnvWithShellPath } from "lib/trpc/routers/workspaces/utils/shell-env";
import * as pty from "node-pty";
import { bundledClaudePath } from "../agent-setup/bundled-claude";
import { parseSetupToken } from "./session";

/**
 * Runs `claude setup-token` with no window: Claude opens the browser, you
 * approve, and the token comes back here. It needs a terminal, so it gets a
 * hidden one, wide enough that the token is never wrapped.
 */
export async function runSetupToken(): Promise<string> {
	const env = await getProcessEnvWithShellPath();
	delete env.ANTHROPIC_API_KEY;
	const claude =
		(env.PATH ?? "")
			.split(delimiter)
			.map((dir) => join(dir, "claude"))
			.find(existsSync) ?? bundledClaudePath();
	if (!claude) throw new Error("Claude Code is not on this computer.");
	return new Promise((resolve, reject) => {
		const proc = pty.spawn(claude, ["setup-token"], {
			cols: 500,
			rows: 50,
			env,
		});
		let output = "";
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error("No approval in the browser within 5 minutes."));
		}, 5 * 60_000);
		proc.onData((chunk) => {
			output += chunk;
		});
		proc.onExit(() => {
			clearTimeout(timer);
			const token = parseSetupToken(output);
			if (token) resolve(token);
			else reject(new Error("claude setup-token ended without a token."));
		});
	});
}
