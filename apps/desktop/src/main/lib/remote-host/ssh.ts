import { Client, utils } from "ssh2";
import { openSsmStream, pushOneTimeKey } from "./ssm";

export interface HostLogin {
	instanceId: string;
	profile?: string | null;
	region?: string | null;
	user: string;
}

/** An SSH connection to the host over SSM, with a one-time key. */
export async function connectHost(host: HostLogin): Promise<Client> {
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
		client.once("ready", resolve).once("error", (err) => {
			// A failed handshake leaves the SSM plugin running otherwise.
			sock.destroy();
			reject(err);
		});
		client.connect({
			sock,
			username: host.user,
			privateKey: key.private,
			readyTimeout: 30_000,
		});
	});
	return client;
}

/** Runs a command on the host, `input` on its stdin; its stdout, or an error with its stderr. */
export function runOnHost(
	client: Client,
	command: string,
	input = "",
): Promise<string> {
	return new Promise((resolve, reject) =>
		client.exec(command, (err, stream) => {
			if (err) return reject(err);
			let out = "";
			let errors = "";
			stream
				.on("data", (chunk: Buffer) => {
					out += chunk;
				})
				.on("close", (code: number) =>
					code === 0 || code === undefined
						? resolve(out.trim())
						: reject(new Error(errors.trim() || `exit ${code}`)),
				);
			stream.stderr.on("data", (chunk: Buffer) => {
				errors += chunk;
			});
			stream.end(input);
		}),
	);
}

/** Copies laptop files to the host over SFTP (paths relative to the login user's home). */
export async function copyFilesToHost(
	host: HostLogin,
	files: { local: string; remote: string }[],
): Promise<void> {
	const client = await connectHost(host);
	try {
		await runOnHost(client, "mkdir -p ~/.odin/files");
		const sftp = await new Promise<import("ssh2").SFTPWrapper>(
			(resolve, reject) =>
				client.sftp((err, s) => (err ? reject(err) : resolve(s))),
		);
		for (const file of files)
			await new Promise<void>((resolve, reject) =>
				sftp.fastPut(file.local, file.remote, (err) =>
					err ? reject(err) : resolve(),
				),
			);
	} finally {
		client.end();
	}
}
