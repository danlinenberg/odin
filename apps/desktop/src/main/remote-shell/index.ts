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
import { basename, dirname, join } from "node:path";
import { EC2Client, RebootInstancesCommand } from "@aws-sdk/client-ec2";
import { Client, type SFTPWrapper, utils } from "ssh2";
import { hostPorts } from "../lib/remote-host/host-service";
import {
	attachScript,
	type RemoteFile,
	type RemoteSessionSpec,
	sh,
	stashScript,
} from "../lib/remote-host/session";
import {
	awsClientConfig,
	openSsmStream,
	pushOneTimeKey,
} from "../lib/remote-host/ssm";

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
 * The host user's tunnel port (hostPorts), to Odin's server on this computer.
 * Every pane of this user forwards the same port to the same Odin, so one
 * holding it is enough; the others try again in case that one closes.
 */
async function forwardOdin(client: Client): Promise<void> {
	const local = Number(process.env.ODIN_PORT);
	const uid = Number.parseInt(
		await exec(client, "id -u", "").catch(() => ""),
		10,
	);
	if (!local || Number.isNaN(uid)) return;
	const { tunnel } = hostPorts(uid);
	client.on("tcp connection", (info, accept, reject) => {
		if (info.destPort !== tunnel) return reject();
		const remote = accept();
		const odin = connect(local, "127.0.0.1");
		remote.pipe(odin).pipe(remote);
		odin.on("error", () => remote.end());
		remote.on("error", () => odin.destroy());
	});
	const bind = () =>
		client.forwardIn("127.0.0.1", tunnel, (err) => {
			if (err && !closed) setTimeout(bind, 15_000).unref();
		});
	let closed = false;
	client.once("close", () => {
		closed = true;
	});
	bind();
}

/**
 * Claude's transcript on the host, appended into ~/.claude/projects here as
 * it grows, so the chat view, Resume and Session History read it like any
 * local session's. Returns what stops it.
 */
function mirrorTranscript(
	client: Client,
	sftp: SFTPWrapper,
	spec: RemoteSessionSpec,
): () => void {
	// Claude files a conversation under its start folder's name; the chat view
	// looks it up by that name, so the copy goes in the same-named folder here.
	let local = "";
	let remote: string | null = null;
	const tick = async () => {
		remote ??=
			(await exec(
				client,
				`ls "$HOME"/.claude/projects/*/${sh(`${spec.pane}.jsonl`)} 2>/dev/null | head -1; true`,
				"",
			).catch(() => "")) || null;
		if (!remote) return;
		local ||= join(
			homedir(),
			".claude",
			"projects",
			basename(dirname(remote)),
			`${spec.pane}.jsonl`,
		);
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
	let stopped = false;
	const loop = () =>
		tick()
			.catch(() => {})
			.finally(() => {
				if (!stopped) setTimeout(loop, 2000).unref();
			});
	loop();
	return () => {
		stopped = true;
	};
}

const ssoExpired = (err: unknown) =>
	/SSO session|token (has expired|is expired)|ExpiredToken/i.test(String(err));

const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

/** `aws sso login` through Odin, which signs in once for every pane waiting on it. */
async function ssoLogin(profile: string | null | undefined): Promise<void> {
	const res = await fetch(
		`http://127.0.0.1:${process.env.ODIN_PORT}/remote-host/sso-login?profile=${encodeURIComponent(profile ?? "")}`,
		{ method: "POST" },
	);
	if (!res.ok || !res.body) throw new Error(await res.text());
	// The body is the approval link, then it ends once the user approved.
	for await (const chunk of res.body)
		process.stderr.write(
			`  2. No tab? Open this link and approve: ${Buffer.from(chunk).toString().trim()}\r\n`,
		);
}

const enter = () =>
	new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		const onData = (key: Buffer) => {
			if (key[0] === 3) process.exit(1);
			if (key[0] !== 13 && key[0] !== 10) return;
			process.stdin.off("data", onData);
			process.stdin.pause();
			resolve();
		};
		process.stdin.on("data", onData);
	});

/** Asks the user to approve a new AWS sign-in until they do; the session can't connect before. */
async function signInAgain(spec: RemoteSessionSpec): Promise<void> {
	for (;;) {
		say(
			bold(
				`Blocked: your AWS sign-in expired, so this session can't reach ${spec.instanceId}.`,
			),
		);
		process.stderr.write(
			"  To fix it:\r\n  1. Approve the AWS sign-in in the browser tab Odin just opened.\r\n",
		);
		try {
			await ssoLogin(spec.profile);
			say("AWS sign-in approved - connecting...");
			return;
		} catch (err) {
			say(
				bold(
					"Still blocked: the AWS sign-in was not approved, so this session is not connected.",
				),
			);
			// A sign-in that fails after the link was sent cuts the connection: fetch says only "terminated".
			const reason =
				err instanceof TypeError
					? ""
					: (err instanceof Error ? err.message : String(err)).split("\n")[0];
			process.stderr.write(
				`  ${reason || "It timed out or was cancelled."}\r\n  To fix it:\r\n  1. Press Enter for a new sign-in link.\r\n`,
			);
			await enter();
		}
	}
}

async function login(
	spec: RemoteSessionSpec,
	target: Parameters<typeof openSsmStream>[0],
): Promise<Client> {
	const key = utils.generateKeyPairSync("ed25519");
	await pushOneTimeKey(target, spec.user, key.public);
	const sock = await openSsmStream(target);
	const client = new Client();
	await new Promise<void>((resolve, reject) => {
		// Not once: a handshake timeout emits an error, then the SSM socket's
		// abort emits another, and an unheard one crashes the helper.
		client.once("ready", resolve).on("error", (err) => {
			// A failed handshake leaves the SSM plugin running otherwise.
			sock.destroy();
			reject(err);
		});
		client.connect({
			sock,
			username: spec.user,
			privateKey: key.private,
			readyTimeout: 60_000,
			// A connection that died quietly (Wi-Fi changed, the Mac slept) ends
			// within 30s, so the pane reconnects instead of hanging on it.
			keepaliveInterval: 10_000,
			keepaliveCountMax: 3,
		});
	});
	return client;
}

async function connectOnce(
	spec: RemoteSessionSpec,
	target: Parameters<typeof openSsmStream>[0],
): Promise<Client> {
	return login(spec, target).catch(async (err: unknown) => {
		if (!ssoExpired(err)) throw err;
		await signInAgain(spec);
		return login(spec, target);
	});
}

/**
 * Attaches this terminal to the session's tmux on the host. Resolves false
 * when the session there ended or you detached from it (tmux exits 0), true
 * when the connection dropped or tmux died (the host ran out of memory).
 */
async function attach(
	client: Client,
	spec: RemoteSessionSpec,
	env: string,
	first: boolean,
): Promise<boolean> {
	const dir = await exec(client, stashScript, env);
	const sftp = await sftpOf(client);
	if (first && spec.files?.length) await upload(sftp, spec.files);
	await forwardOdin(client);
	const stopMirror = mirrorTranscript(client, sftp, spec);
	const { stdin, stdout } = process;
	return new Promise((resolve, reject) =>
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
				if (err) return reject(err);
				// Only a command that finished sends an exit status; a dropped
				// connection doesn't, and a killed tmux exits non-zero or by signal.
				let exited = false;
				const resize = () =>
					stream.setWindow(stdout.rows ?? 40, stdout.columns ?? 120, 0, 0);
				stdin.setRawMode?.(true);
				stdin.pipe(stream);
				stream.pipe(stdout, { end: false });
				stream.stderr.pipe(process.stderr, { end: false });
				stdout.on("resize", resize);
				stream.on("exit", (code: number | null) => {
					exited = code === 0;
				});
				// A connection that drops closes the client but not this stream.
				let done = false;
				const end = () => {
					if (done) return;
					done = true;
					stdin.unpipe(stream);
					stdout.off("resize", resize);
					stopMirror();
					client.end();
					resolve(!exited);
				};
				stream.on("close", end);
				client.once("close", end);
			},
		),
	);
}

/** Waits `ms`, or until you press R; true when you did. */
const waitOrR = (ms: number) =>
	new Promise<boolean>((resolve) => {
		const { stdin } = process;
		const done = (pressed: boolean) => {
			clearTimeout(timer);
			stdin.off("data", onKey);
			stdin.pause();
			resolve(pressed);
		};
		const onKey = (key: Buffer) => {
			if (key[0] === 3) process.exit(1);
			if (key[0] === 0x72 || key[0] === 0x52) done(true);
		};
		const timer = setTimeout(() => done(false), ms);
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.on("data", onKey);
	});

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
	// A host busy enough to miss the SSH handshake answers a later try. The
	// wait doubles up to 5 minutes, with jitter, so a host's panes don't all
	// retry together and keep it busy. A host that keeps failing is usually
	// wedged (out of memory); after 3 tries you can reboot it from here, with
	// the AWS sign-in the pane already uses.
	const reconnect = async (): Promise<Client> => {
		for (let wait = 10_000, tries = 1; ; tries++) {
			try {
				return await connectOnce(spec, target);
			} catch (err) {
				const delay = wait / 2 + Math.random() * (wait / 2);
				const offer =
					tries >= 3 ? ` (press R to reboot ${spec.instanceId})` : "";
				say(
					`could not reconnect: ${err instanceof Error ? err.message : String(err)} - trying again in ${Math.round(delay / 1000)}s${offer}`,
				);
				wait = Math.min(wait * 2, 300_000);
				const pressedR = offer
					? await waitOrR(delay)
					: await new Promise<false>((resolve) =>
							setTimeout(() => resolve(false), delay),
						);
				if (!pressedR) continue;
				try {
					await new EC2Client(awsClientConfig(target)).send(
						new RebootInstancesCommand({ InstanceIds: [spec.instanceId] }),
					);
					say(`rebooting ${spec.instanceId} - reconnecting once it is back...`);
					// Its sessions restart there and resume; give it time to boot.
					await new Promise((resolve) => setTimeout(resolve, 60_000));
					wait = 10_000;
					tries = 0;
				} catch (rebootErr) {
					say(
						`could not reboot: ${rebootErr instanceof Error ? rebootErr.message : String(rebootErr)}`,
					);
				}
			}
		}
	};
	say(`connecting to ${spec.instanceId}...`);
	let client = await connectOnce(spec, target).catch(reconnect);
	// Claude keeps working in tmux on the host while the connection is down.
	// If tmux is gone by then, the conversation resumes instead of starting over.
	const again: RemoteSessionSpec = {
		...spec,
		claudeArgs: `--resume ${spec.pane}`,
		prompt: null,
		fresh: false,
	};
	for (let first = true; ; first = false) {
		const dropped = await attach(
			client,
			first ? spec : again,
			env,
			first,
		).catch(() => true);
		if (!dropped) break;
		say(`connection lost - reconnecting to ${spec.instanceId}...`);
		client = await reconnect();
	}
	process.exit(0);
}

main().catch((err: unknown) => {
	say(`could not connect: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
