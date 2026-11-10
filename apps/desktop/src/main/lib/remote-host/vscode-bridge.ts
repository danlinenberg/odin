import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import {
	awsSsoLogin,
	isAwsSignInExpired,
} from "lib/trpc/routers/terminal/aws-sso";
import { utils } from "ssh2";
import { ODIN_HOME_DIR } from "../app-environment";
import { sh } from "./session";
import { adminLogin, connectHost, type HostLogin, runOnHost } from "./ssh";
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
		name: host.name,
		profile: host.profile,
		region: host.region,
	};
	const server = net.createServer((socket) => {
		socket.pause();
		// Over SSM: the key line lasts 3 minutes and needs no lookup on the
		// host, so it is there whatever the host's Instance Connect setup.
		const connect = async () => {
			await pushOneTimeKey(target, host.user, publicKey, { overSsm: true });
			return openSsmStream(target);
		};
		void (async () => {
			// VS Code can't sign in to AWS itself: an expired sign-in opens
			// Odin's approval page and the connection goes on once it's approved.
			const stream = await connect().catch(async (error: unknown) => {
				if (!isAwsSignInExpired(error)) throw error;
				await awsSsoLogin(host.profile ?? null).done;
				return connect();
			});
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

/**
 * Opens the local port again for each host `~/.ssh/config` still names, at
 * Odin's start: a VS Code window left open on the host reconnects on its own
 * instead of waiting for the next "Open in VS Code on the host".
 */
export async function reopenVscodeBridges(
	hosts: (HostLogin & { name?: string | null })[],
): Promise<void> {
	const path = sshConfigPath();
	if (!existsSync(path)) return;
	const config = readFileSync(path, "utf8");
	for (const host of hosts) {
		if (entryPort(config, hostAlias(host.name || host.instanceId)) === null)
			continue;
		await vscodeHost(host).catch((error) =>
			console.warn("[remote-host] VS Code bridge:", error),
		);
	}
}

/**
 * VS Code's user settings set up for the host: Remote-SSH told it runs Linux,
 * so the first connection doesn't stop to ask, and this computer's
 * extensions listed in `remote.SSH.defaultExtensions`, so Remote-SSH installs
 * them there too. Null when there is nothing to change, or the file isn't
 * plain JSON (comments): it is left as it is then.
 */
export function withHostSettings(
	settings: string,
	alias: string,
	extensions: string[] = [],
): string | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = settings.trim() ? JSON.parse(settings) : {};
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return null;
	const platforms = parsed["remote.SSH.remotePlatform"] ?? {};
	const listed = parsed["remote.SSH.defaultExtensions"] ?? [];
	if (typeof platforms !== "object" || !Array.isArray(listed)) return null;
	// The remote extensions themselves only belong on this computer.
	const added = extensions.filter(
		(id) => !id.startsWith("ms-vscode-remote.") && !listed.includes(id),
	);
	const hasPlatform = !!(platforms as Record<string, string>)[alias];
	if (hasPlatform && !added.length) return null;
	if (!hasPlatform)
		parsed["remote.SSH.remotePlatform"] = { ...platforms, [alias]: "linux" };
	if (added.length)
		parsed["remote.SSH.defaultExtensions"] = [...listed, ...added];
	return `${JSON.stringify(parsed, null, 4)}\n`;
}

/** Sets up VS Code's user settings for the host (see withHostSettings). */
export async function setVsCodeHostSettings(
	alias: string,
	extensions: string[],
): Promise<void> {
	const dir =
		process.platform === "darwin"
			? join(os.homedir(), "Library", "Application Support", "Code", "User")
			: join(os.homedir(), ".config", "Code", "User");
	const path = join(dir, "settings.json");
	const next = withHostSettings(
		existsSync(path) ? await readFile(path, "utf8") : "",
		alias,
		extensions,
	);
	if (next === null) return;
	await mkdir(dir, { recursive: true });
	await writeFile(path, next);
}

/** This computer's zsh startup files, copied for VS Code's terminal on the host. */
const ZSH_FILES = [".zshenv", ".zprofile", ".zshrc"];

/**
 * The host-side script that makes this computer's zsh setup VS Code's
 * terminal there: zsh as its default profile, with ZDOTDIR on the copied
 * startup files in `dir`, so the host's own home files stay as they are.
 * Written to the VS Code server's machine settings, which only apply on this
 * host; a file that isn't plain JSON is left alone.
 */
export function machineSettingsScript(dir: string): string {
	const py = [
		"import json, os, sys",
		"p = os.path.expanduser('~/.vscode-server/data/Machine/settings.json')",
		"os.makedirs(os.path.dirname(p), exist_ok=True)",
		"try:",
		"    s = json.load(open(p)) if os.path.exists(p) else {}",
		"except Exception:",
		"    sys.exit(0)",
		"s['terminal.integrated.defaultProfile.linux'] = 'zsh'",
		"env = s.get('terminal.integrated.env.linux') or {}",
		`env['ZDOTDIR'] = ${JSON.stringify(dir)}`,
		"s['terminal.integrated.env.linux'] = env",
		"json.dump(s, open(p, 'w'), indent=4)",
	].join("\n");
	return `python3 -c ${sh(py)}`;
}

/**
 * Brings this computer's zsh setup to VS Code's terminal on the host: zsh
 * installed there (through the admin login's sudo) and the startup files
 * copied to `~/.odin/mac-shell`. Skipped when the shell here isn't zsh or
 * zsh can't be installed there.
 */
export async function bringShellToHost(host: HostLogin): Promise<void> {
	if (!/zsh$/.test(process.env.SHELL ?? "")) return;
	const files = ZSH_FILES.map((name) => join(os.homedir(), name)).filter(
		(path) => existsSync(path),
	);
	if (!files.length) return;
	const install =
		"command -v zsh >/dev/null || { export DEBIAN_FRONTEND=noninteractive; if command -v apt-get >/dev/null; then sudo -n apt-get install -y -q zsh || { sudo -n apt-get update -q && sudo -n apt-get install -y -q zsh; }; else sudo -n dnf install -y -q zsh || sudo -n yum install -y -q zsh; fi; } >/dev/null 2>&1";
	const admin = await connectHost(adminLogin(host));
	try {
		await runOnHost(admin, install).catch(() => {});
	} finally {
		admin.end();
	}
	const client = await connectHost(host);
	try {
		await runOnHost(client, "command -v zsh");
		const dir = `/home/${host.user}/.odin/mac-shell`;
		await runOnHost(client, `mkdir -p ${sh(dir)}`);
		for (const path of files)
			await runOnHost(
				client,
				`cat > ${sh(`${dir}/${path.split("/").pop()}`)}`,
				await readFile(path, "utf8"),
			);
		await runOnHost(client, machineSettingsScript(dir));
	} finally {
		client.end();
	}
}

/** VS Code's address for a folder on an ssh host. */
export const remoteFolderUri = (alias: string, dir: string) =>
	`vscode-remote://ssh-remote+${alias}${encodeURI(dir.startsWith("/") ? dir : `/${dir}`)}`;
