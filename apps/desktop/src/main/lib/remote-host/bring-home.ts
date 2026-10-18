import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, type SFTPWrapper, utils } from "ssh2";
import { sh, tmuxSession } from "./session";
import { openSsmStream, pushOneTimeKey } from "./ssm";

interface Host {
	instanceId: string;
	profile?: string | null;
	region?: string | null;
	user: string;
}

/** Claude's folder name for a cwd under ~/.claude/projects. */
export const claudeProjectDir = (cwd: string) =>
	cwd.replace(/[^A-Za-z0-9]/g, "-");

function run(client: Client, command: string): Promise<string> {
	return new Promise((resolve, reject) =>
		client.exec(command, (err, stream) => {
			if (err) return reject(err);
			let out = "";
			stream
				.on("data", (chunk: Buffer) => {
					out += chunk;
				})
				.on("close", () => resolve(out.trim()));
			stream.stderr.resume();
		}),
	);
}

/**
 * Moves a remote session's conversation to this computer: copies Claude's
 * transcript from the host into ~/.claude/projects for `cwd`, so
 * `claude --resume` finds it here, and ends the session's tmux session on
 * the host so the two never both answer.
 */
export async function bringSessionHome(
	host: Host,
	sessionId: string,
	cwd: string,
): Promise<void> {
	const target = {
		instanceId: host.instanceId,
		profile: host.profile,
		region: host.region,
	};
	const key = utils.generateKeyPairSync("ed25519");
	await pushOneTimeKey(target, host.user, key.public);
	const sock = await openSsmStream(target);
	const client = new Client();
	await new Promise<void>((resolve, reject) => {
		client.once("ready", resolve).once("error", reject);
		client.connect({
			sock,
			username: host.user,
			privateKey: key.private,
			readyTimeout: 30_000,
		});
	});
	try {
		const remote = await run(
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
		await run(
			client,
			`tmux kill-session -t ${sh(tmuxSession(sessionId))} 2>/dev/null; true`,
		);
	} finally {
		client.end();
	}
}
