/**
 * The program a remote session's pane runs (under ELECTRON_RUN_AS_NODE): it
 * logs in to the host over SSM with a one-time key and connects this terminal
 * to the session's tmux session there. argv[2] is the base64 JSON spec. The
 * user's tokens come from Odin's local server with a single-use ticket
 * (argv[3]), so they are on no command line.
 */

import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, type SFTPWrapper, utils } from "ssh2";
import {
	attachScript,
	REMOTE_ODIN_PORT,
	type RemoteFile,
	type RemoteSessionSpec,
	sh,
	stashScript,
} from "../lib/remote-host/session";
import { openSsmStream, pushOneTimeKey } from "../lib/remote-host/ssm";

const say = (text: string) => process.stderr.write(`\r\nOdin: ${text}\r\n`);

async function tokens(ticket: string | undefined): Promise<string> {
	if (!ticket || !process.env.ODIN_PORT) return "";
	const res = await fetch(
		`http://127.0.0.1:${process.env.ODIN_PORT}/remote-host/env?ticket=${encodeURIComponent(ticket)}`,
	).catch(() => null);
	// A used ticket (a pane restored after a restart) only matters for a new
	// session; reattaching needs no tokens.
	return res?.ok ? await res.text() : "";
}

function exec(client: Client, command: string, input: string): Promise<string> {
	return new Promise((resolve, reject) => {
		client.exec(command, (err, stream) => {
			if (err) return reject(err);
			let out = "";
			stream.on("data", (chunk: Buffer) => {
				out += chunk;
			});
			stream.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
			stream.on("close", (code: number) =>
				code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`)),
			);
			stream.end(input);
		});
	});
}

const sftpOf = (client: Client) =>
	new Promise<SFTPWrapper>((resolve, reject) =>
		client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))),
	);

/** The prompt's laptop files, to where the prompt now says they are. */
async function upload(sftp: SFTPWrapper, files: RemoteFile[]): Promise<void> {
	for (const dir of [".odin", ".odin/files"])
		await new Promise<void>((resolve) => sftp.mkdir(dir, () => resolve()));
	for (const file of files)
		await new Promise<void>((resolve) =>
			sftp.fastPut(file.local, file.remote, (err) => {
				if (err) say(`could not copy ${file.local}: ${err.message}`);
				resolve();
			}),
		);
}

/**
 * The host's 127.0.0.1:REMOTE_ODIN_PORT, to Odin's server on this computer.
 * Every pane on the host forwards the same port to the same Odin, so one
 * holding it is enough; the others try again in case that one closes.
 */
function forwardOdin(client: Client): void {
	const local = Number(process.env.ODIN_PORT);
	if (!local) return;
	client.on("tcp connection", (info, accept, reject) => {
		if (info.destPort !== REMOTE_ODIN_PORT) return reject();
		const remote = accept();
		const odin = connect(local, "127.0.0.1");
		remote.pipe(odin).pipe(remote);
		odin.on("error", () => remote.end());
		remote.on("error", () => odin.destroy());
	});
	const bind = () =>
		client.forwardIn("127.0.0.1", REMOTE_ODIN_PORT, (err) => {
			if (err) setTimeout(bind, 15_000).unref();
		});
	bind();
}

/**
 * Claude's transcript on the host, appended into ~/.claude/projects here as
 * it grows, so the chat view, Resume and Session History read it like any
 * local session's.
 */
function mirrorTranscript(
	client: Client,
	sftp: SFTPWrapper,
	spec: RemoteSessionSpec,
): void {
	const local = join(
		homedir(),
		".claude",
		"projects",
		`odin-remote-${spec.instanceId}`,
		`${spec.pane}.jsonl`,
	);
	let remote: string | null = null;
	const tick = async () => {
		remote ??=
			(await exec(
				client,
				`ls "$HOME"/.claude/projects/*/${sh(`${spec.pane}.jsonl`)} 2>/dev/null | head -1; true`,
				"",
			).catch(() => "")) || null;
		if (!remote) return;
		const size = await new Promise<number>((resolve) =>
			sftp.stat(remote as string, (err, st) => resolve(err ? 0 : st.size)),
		);
		const have = await stat(local).then(
			(st) => st.size,
			() => -1,
		);
		if (size === 0 || size === have) return;
		await mkdir(join(local, ".."), { recursive: true });
		// Shorter here means more to append; longer means the host's file was rewritten.
		const start = have > 0 && have < size ? have : 0;
		const chunks: Buffer[] = [];
		await new Promise<void>((resolve) =>
			sftp
				.createReadStream(remote as string, { start, end: size - 1 })
				.on("data", (chunk: Buffer) => chunks.push(chunk))
				.on("error", () => resolve())
				.on("close", () => resolve()),
		);
		const data = Buffer.concat(chunks);
		if (start === 0) await writeFile(local, data);
		else await appendFile(local, data);
	};
	const loop = () =>
		tick()
			.catch(() => {})
			.finally(() => setTimeout(loop, 2000).unref());
	loop();
}

async function main(): Promise<void> {
	const spec = JSON.parse(
		Buffer.from(process.argv[2] ?? "", "base64").toString(),
	) as RemoteSessionSpec;
	const env = await tokens(process.argv[3]);
	const target = {
		instanceId: spec.instanceId,
		profile: spec.profile,
		region: spec.region,
	};
	say(`connecting to ${spec.instanceId}...`);
	const key = utils.generateKeyPairSync("ed25519");
	await pushOneTimeKey(target, spec.user, key.public);
	const sock = await openSsmStream(target);
	const client = new Client();
	await new Promise<void>((resolve, reject) => {
		client.once("ready", resolve).once("error", reject);
		client.connect({
			sock,
			username: spec.user,
			privateKey: key.private,
			readyTimeout: 30_000,
		});
	});

	const dir = await exec(client, stashScript, env);
	const sftp = await sftpOf(client);
	if (spec.files?.length) await upload(sftp, spec.files);
	forwardOdin(client);
	mirrorTranscript(client, sftp, spec);
	const { stdin, stdout } = process;
	client.exec(
		`bash -lc ${sh(attachScript(spec, dir))}`,
		{
			pty: {
				term: process.env.TERM ?? "xterm-256color",
				cols: stdout.columns ?? 120,
				rows: stdout.rows ?? 40,
			},
		},
		(err, stream) => {
			if (err) throw err;
			stdin.setRawMode?.(true);
			stdin.pipe(stream);
			stream.pipe(stdout);
			stream.stderr.pipe(process.stderr);
			stdout.on("resize", () =>
				stream.setWindow(stdout.rows ?? 40, stdout.columns ?? 120, 0, 0),
			);
			stream.on("close", () => {
				client.end();
				process.exit(0);
			});
		},
	);
}

main().catch((err: unknown) => {
	say(`could not connect: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
