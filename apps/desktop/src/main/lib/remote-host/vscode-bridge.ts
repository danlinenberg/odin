import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { ODIN_HOME_DIR } from "../app-environment";
import type { HostLogin } from "./ssh";
import { openSsmStream, pushOneTimeKey } from "./ssm";

/**
 * VS Code on the host, through Remote-SSH, with the same path Odin's own
 * connections take: no open port, no public IP and no key on the host that
 * outlives a login. Odin listens on a local port; each connection VS Code's
 * ssh makes there gets a one-time key line for Odin's VS Code key and an SSM
 * stream to the host's port 22. `~/.ssh/config` gets a Host entry for that
 * port, so VS Code (and a plain `ssh odin-<host>`) find it by name.
 */

const DIR = join(ODIN_HOME_DIR, "vscode");

/** VS Code's login key, made once. Its public half is only ever a one-time key line on a host. */
async function bridgeKey(dir = DIR): Promise<{ path: string; public: string }> {
	const path = join(dir, "id_ed25519");
	if (!existsSync(path) || !existsSync(`${path}.pub`)) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const key = utils.generateKeyPairSync("ed25519", {
			comment: "odin-vscode",
		});
		await writeFile(path, key.private, { mode: 0o600 });
		await writeFile(`${path}.pub`, `${key.public}\n`);
	}
	await chmod(path, 0o600);
	return { path, public: (await readFile(`${path}.pub`, "utf8")).trim() };
}

/** The ssh name of a host: `odin-<its name>`, in characters ssh config takes. */
export function hostAlias(name: string): string {
	const safe = name.replace(/[^A-Za-z0-9._-]/g, "-");
	return safe.startsWith("odin-") ? safe : `odin-${safe}`;
}

const begin = (alias: string) => `# Odin: ${alias} - begin`;
const end = (alias: string) => `# Odin: ${alias} - end`;

/**
 * `config` with this host's entry in place of the one Odin wrote before.
 * A new one goes at the top: ssh takes the first value it finds, so a
 * `Host *` further down can't override its User or key.
 */
export function withHostEntry(
	config: string,
	alias: string,
	entry: {
		port: number;
		user: string;
		keyPath: string;
		knownHosts: string;
		hostKeyAlias: string;
	},
): string {
	const block = [
		begin(alias),
		`Host ${alias}`,
		"  HostName 127.0.0.1",
		`  Port ${entry.port}`,
		`  User ${entry.user}`,
		`  IdentityFile "${entry.keyPath}"`,
		"  IdentitiesOnly yes",
		// The port changes between runs; the host's key doesn't.
		`  HostKeyAlias ${entry.hostKeyAlias}`,
		`  UserKnownHostsFile "${entry.knownHosts}"`,
		"  StrictHostKeyChecking accept-new",
		end(alias),
	].join("\n");
	const start = config.indexOf(begin(alias));
	const stop = config.indexOf(end(alias));
	if (start !== -1 && stop > start)
		return (
			config.slice(0, start) + block + config.slice(stop + end(alias).length)
		);
	return config ? `${block}\n\n${config}` : `${block}\n`;
}

/** The port this host's entry had, to listen on again after a restart: VS Code's saved window still points there. */
export function entryPort(config: string, alias: string): number | null {
	const start = config.indexOf(begin(alias));
	const stop = config.indexOf(end(alias));
	if (start === -1 || stop < start) return null;
	const port = /^\s*Port (\d+)$/m.exec(config.slice(start, stop))?.[1];
	return port ? Number(port) : null;
}

const sshConfigPath = () => join(os.homedir(), ".ssh", "config");

function listen(server: net.Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (err: Error) => reject(err);
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", onError);
			resolve((server.address() as net.AddressInfo).port);
		});
	});
}

/** One local port per host and login, for as long as Odin runs. */
const bridges = new Map<string, Promise<number>>();

function startBridge(
	host: HostLogin,
	publicKey: string,
	preferred: number | null,
) {
	const target = {
		instanceId: host.instanceId,
		profile: host.profile,
		region: host.region,
	};
	const server = net.createServer((socket) => {
		socket.pause();
		void (async () => {
			// Over SSM: the key line lasts 3 minutes and needs no lookup on the
			// host, so it is there whatever the host's Instance Connect setup.
			await pushOneTimeKey(target, host.user, publicKey, { overSsm: true });
			const stream = await openSsmStream(target);
			socket.on("error", () => stream.destroy());
			stream.on("error", () => socket.destroy());
			socket.on("close", () => stream.destroy());
			stream.on("close", () => socket.destroy());
			socket.pipe(stream).pipe(socket);
			socket.resume();
		})().catch((error: unknown) => {
			console.warn("[remote-host] VS Code connection:", error);
			socket.destroy();
		});
	});
	server.unref();
	return (async () => {
		if (preferred) {
			const port = await listen(server, preferred).catch(() => null);
			if (port) return port;
		}
		return listen(server, 0);
	})();
}

/**
 * The ssh name VS Code connects to for this host: the local port is open and
 * `~/.ssh/config` names it.
 */
export async function vscodeHost(
	host: HostLogin & { name?: string | null },
): Promise<string> {
	const alias = hostAlias(host.name || host.instanceId);
	const key = await bridgeKey();
	const configPath = sshConfigPath();
	const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
	const id = `${host.instanceId}:${host.user}`;
	let bridge = bridges.get(id);
	if (!bridge) {
		bridge = startBridge(host, key.public, entryPort(config, alias));
		bridges.set(id, bridge);
		bridge.catch(() => bridges.delete(id));
	}
	const port = await bridge;
	const next = withHostEntry(config, alias, {
		port,
		user: host.user,
		keyPath: key.path,
		knownHosts: join(DIR, "known_hosts"),
		hostKeyAlias: hostAlias(host.instanceId),
	});
	if (next !== config) {
		await mkdir(join(os.homedir(), ".ssh"), { recursive: true, mode: 0o700 });
		await writeFile(configPath, next, { mode: 0o600 });
	}
	return alias;
}

/** VS Code's address for a folder on an ssh host. */
export const remoteFolderUri = (alias: string, dir: string) =>
	`vscode-remote://ssh-remote+${alias}${encodeURI(dir.startsWith("/") ? dir : `/${dir}`)}`;
