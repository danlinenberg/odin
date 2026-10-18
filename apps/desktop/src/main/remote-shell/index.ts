/**
 * The program a remote session's pane runs (under ELECTRON_RUN_AS_NODE): it
 * logs in to the host over SSM with a one-time key and connects this terminal
 * to the session's tmux session there. argv[2] is the base64 JSON spec. The
 * user's tokens come from Odin's local server with a single-use ticket
 * (argv[3]), so they are on no command line.
 */

import { Client, utils } from "ssh2";
import {
	attachScript,
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
