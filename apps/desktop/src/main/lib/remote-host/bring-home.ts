import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SFTPWrapper } from "ssh2";
import { sh, tmuxSession } from "./session";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

/** Claude's folder name for a cwd under ~/.claude/projects. */
export const claudeProjectDir = (cwd: string) =>
	cwd.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Moves a remote session's conversation to this computer: copies Claude's
 * transcript from the host into ~/.claude/projects for `cwd`, so
 * `claude --resume` finds it here, and ends the session's tmux session on
 * the host so the two never both answer.
 */
export async function bringSessionHome(
	host: HostLogin,
	sessionId: string,
	cwd: string,
): Promise<void> {
	const client = await connectHost(host);
	try {
		const remote = await runOnHost(
			client,
			`ls "$HOME"/.claude/projects/*/${sh(`${sessionId}.jsonl`)} 2>/dev/null | head -1`,
		);
		if (!remote)
			throw new Error("The host has no conversation for this session.");
		const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
			client.sftp((err, s) => (err ? reject(err) : resolve(s))),
		);
		const data = await new Promise<Buffer>((resolve, reject) =>
			sftp.readFile(remote, (err, buf) => (err ? reject(err) : resolve(buf))),
		);
		const dir = join(homedir(), ".claude", "projects", claudeProjectDir(cwd));
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${sessionId}.jsonl`), data);
		await runOnHost(client, killTmux(sessionId));
	} finally {
		client.end();
	}
}

const killTmux = (sessionId: string) =>
	`tmux kill-session -t ${sh(tmuxSession(sessionId))} 2>/dev/null; true`;

/** Ends a remote session's tmux session on the host: Claude there stops. */
export async function endHostSession(
	host: HostLogin,
	sessionId: string,
): Promise<void> {
	const client = await connectHost(host);
	try {
		await runOnHost(client, killTmux(sessionId));
	} finally {
		client.end();
	}
}
