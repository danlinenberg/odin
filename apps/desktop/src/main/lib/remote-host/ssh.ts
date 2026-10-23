import { Client, utils } from "ssh2";
import { openSsmStream, pushOneTimeKey } from "./ssm";

export interface HostLogin {
	instanceId: string;
	profile?: string | null;
	region?: string | null;
	/** The Linux user sessions run as: this Odin user's own on the host. */
	user: string;
	/** The instance's own login, with sudo (ubuntu), for root's work. Unset: `user`, from when users shared one login. */
	adminUser?: string | null;
}

/** The same host, logged in as its admin login. */
export const adminLogin = (host: HostLogin): HostLogin => ({
	...host,
	user: host.adminUser || host.user,
});

/**
 * An SSH connection to the host over SSM, with a one-time key. A host too busy
 * to finish the handshake in time gets two more tries, 10s apart.
 */
export async function connectHost(host: HostLogin): Promise<Client> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await connectOnce(host);
		} catch (err) {
			const level = (err as { level?: string }).level;
			const handshake = level === "client-timeout" || level === "client-socket";
			if (!handshake || attempt === 3) throw err;
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		}
	}
}

async function connectOnce(host: HostLogin): Promise<Client> {
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
		// Not once: a handshake timeout emits an error, then the SSM socket's
		// abort emits another, and an unheard one crashes the app.
		client.once("ready", resolve).on("error", (err) => {
			// A failed handshake leaves the SSM plugin running otherwise.
			sock.destroy();
			reject(err);
		});
		client.connect({
			sock,
			username: host.user,
			privateKey: key.private,
			readyTimeout: 60_000,
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

/** How long a file-copy connection stays open after its last copy. */
const KEEP_MS = 3 * 60_000;

type Kept = {
	ready: Promise<{ client: Client; sftp: import("ssh2").SFTPWrapper }>;
	timer?: ReturnType<typeof setTimeout>;
};
const kept = new Map<string, Kept>();

function forget(key: string, entry: Kept): void {
	clearTimeout(entry.timer);
	if (kept.get(key) === entry) kept.delete(key);
}

/** The open SFTP connection to this host and login, or a new one. */
function sftpSession(host: HostLogin): { entry: Kept; reused: boolean } {
	const key = `${host.instanceId}:${host.user}`;
	const hit = kept.get(key);
	if (hit) return { entry: hit, reused: true };
	const entry: Kept = {
		ready: (async () => {
			const client = await connectHost(host);
			client
				.on("close", () => forget(key, entry))
				.on("error", () => forget(key, entry));
			try {
				await runOnHost(client, "mkdir -p ~/.odin/files");
				const sftp = await new Promise<import("ssh2").SFTPWrapper>(
					(resolve, reject) =>
						client.sftp((err, s) => (err ? reject(err) : resolve(s))),
				);
				return { client, sftp };
			} catch (error) {
				client.end();
				throw error;
			}
		})(),
	};
	entry.ready.catch(() => forget(key, entry));
	kept.set(key, entry);
	return { entry, reused: false };
}

/**
 * Copies laptop files to the host over SFTP (paths relative to the login
 * user's home). A connection takes seconds to open - a one-time key, an SSM
 * session, the SSH handshake - and a chat message with a screenshot paid all
 * of it every time. So the connection stays open a few minutes after a copy;
 * one that died meanwhile is opened again once.
 */
export async function copyFilesToHost(
	host: HostLogin,
	files: { local: string; remote: string }[],
): Promise<void> {
	const key = `${host.instanceId}:${host.user}`;
	for (;;) {
		const { entry, reused } = sftpSession(host);
		clearTimeout(entry.timer);
		try {
			const { client, sftp } = await entry.ready;
			for (const file of files)
				await new Promise<void>((resolve, reject) =>
					sftp.fastPut(file.local, file.remote, (err) =>
						err ? reject(err) : resolve(),
					),
				);
			entry.timer = setTimeout(() => {
				forget(key, entry);
				client.end();
			}, KEEP_MS);
			entry.timer.unref?.();
			return;
		} catch (error) {
			forget(key, entry);
			void entry.ready.then(({ client }) => client.end()).catch(() => {});
			if (!reused) throw error;
		}
	}
}
