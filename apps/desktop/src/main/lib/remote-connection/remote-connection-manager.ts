import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import path from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import { configPath as odinConfigPath } from "lib/trpc/routers/odin-config";
import { env as sharedEnv } from "shared/env.shared";
import { Client, type ConnectConfig, type SFTPWrapper, utils } from "ssh2";
import { ODIN_HOME_DIR } from "../app-environment";
import {
	findFreePort,
	HEALTH_POLL_TIMEOUT_MS,
	pollHealthCheck,
} from "../host-service-utils";
import { HOOK_PROTOCOL_VERSION } from "../terminal/env";
import {
	ELECTRON_SHIM_PACKAGE_JSON,
	ELECTRON_SHIM_SOURCE,
} from "./electron-shim";
import {
	buildClaudeInstallCommand,
	buildRemoteAgentFiles,
	mergeRemoteClaudeSettings,
} from "./remote-agent-setup";
import {
	ALREADY_RUNNING_MARKER,
	buildNodeInstallCommand,
	buildProvisionCommand,
	buildRemoteStartCommand,
	buildTestCommand,
	checkHostKey,
	collectBundleFiles,
	hostKeyFingerprint,
	parseTestOutput,
	REMOTE_AUTH_PROBE_PATH,
	REMOTE_ELECTRON_SHIM_DIR,
	REMOTE_LOCAL_DB_MIGRATIONS_DIRNAME,
	REMOTE_RUNTIME_DEPS,
	shellQuote,
	startCommandStdin,
} from "./ssh";
import type {
	ActiveRemote,
	RemoteConnectionConfig,
	RemoteConnectionStatus,
	RemoteConnectionStatusEvent,
	TestConnectionResult,
} from "./types";

/** The desktop local DB's migrations, shipped for the server's connection code. */
function localDbMigrationsSource(): string {
	return app.isPackaged
		? path.join(process.resourcesPath, "resources/migrations")
		: path.join(app.getAppPath(), "../../packages/local-db/drizzle");
}

/** Organization scope for a remote backend - one host per remote for now. */
const REMOTE_ORGANIZATION_ID = "remote";
/** SSH handshake timeout. */
const SSH_READY_TIMEOUT_MS = 20_000;
/** Remote layout under the configured odin folder. */
const REMOTE_BACKEND_DIRNAME = "backend";
const REMOTE_BUNDLE_NAME = "host-service.js";
const REMOTE_MIGRATIONS_DIRNAME = "host-migrations";
/**
 * Bundle entry points the remote backend needs beside each other. The worker
 * pool resolves host-worker.js and the daemon supervisor resolves
 * pty-daemon.js next to host-service.js. The chunks they load are collected
 * from these by {@link collectBundleFiles}. Native addons are not copied -
 * they are installed on the remote for its own platform.
 */
const REMOTE_BUNDLE_ENTRIES = [
	"host-service.js",
	"host-worker.js",
	"pty-daemon.js",
];
/** Host keys seen on first connect, by "host:port" - see {@link checkHostKey}. */
const KNOWN_HOSTS_PATH = path.join(ODIN_HOME_DIR, "remote-known-hosts.json");

function readKnownHosts(): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(KNOWN_HOSTS_PATH, "utf8"));
	} catch {
		return {};
	}
}

/** Log lines quoted back when the remote backend fails to come up. */
const REMOTE_LOG_TAIL_LINES = 30;
/** Backoff between reconnect attempts after the tunnel drops: 2s up to 1min. */
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return path.join(os.homedir(), filePath.slice(2));
	}
	return filePath;
}

/** Platform path to the running SSH agent, if any. */
function sshAgentPath(): string | undefined {
	if (process.platform === "win32") return "\\\\.\\pipe\\openssh-ssh-agent";
	return process.env.SSH_AUTH_SOCK || undefined;
}

/** First existing default private key under ~/.ssh, if any. */
function defaultPrivateKeyPath(): string | null {
	const dir = path.join(os.homedir(), ".ssh");
	for (const name of ["id_ed25519", "id_rsa", "id_ecdsa"]) {
		const candidate = path.join(dir, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Owns SSH-managed remote backends through the in-process ssh2 client (so
 * password auth works on every platform, Windows included). It provisions and
 * starts the host-service on the remote and keeps one SSH connection open that
 * carries both control channels and a forwarded local port. Disconnecting
 * closes only the local side - the remote daemon keeps running so agents
 * outlive the laptop.
 */
export class RemoteConnectionManager {
	private readonly emitter = new EventEmitter();
	private client: Client | null = null;
	private tunnelServer: net.Server | null = null;
	private active: ActiveRemote | null = null;
	/**
	 * The server the user chose to run on, kept while the tunnel is down. Odin
	 * stays in remote mode for it - sessions are not re-homed to the laptop
	 * because Wi-Fi blinked - and keeps reconnecting until disconnect().
	 */
	private desired: RemoteConnectionConfig | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;

	onStatusChange(
		listener: (event: RemoteConnectionStatusEvent) => void,
	): () => void {
		this.emitter.on("status", listener);
		return () => this.emitter.off("status", listener);
	}

	getActive(): ActiveRemote | null {
		return this.active;
	}

	/**
	 * Whether sessions run on a server: true from a successful connect until
	 * disconnect(), including while the tunnel is down and reconnecting.
	 */
	isRemoteMode(): boolean {
		return this.desired !== null;
	}

	/**
	 * Re-enter remote mode for a server chosen in an earlier run (the app
	 * restarted, or the laptop rebooted). Keeps retrying in the background
	 * until it connects or the user disconnects.
	 */
	resume(config: RemoteConnectionConfig): void {
		this.desired = config;
		this.reconnectAttempt = 0;
		this.attemptReconnect();
	}

	/** Probe reachability, the server's OS and CPU, and that the odin folder is writable. */
	async testConnection(
		config: RemoteConnectionConfig,
	): Promise<TestConnectionResult> {
		let client: Client | null = null;
		try {
			client = await this.openClient(config);
			const resolved = await this.resolveConfig(client, config);
			const result = await this.exec(client, buildTestCommand(resolved));
			return parseTestOutput(result.stdout, true, result.stderr);
		} catch (error) {
			return parseTestOutput(
				"",
				false,
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			client?.end();
		}
	}

	/**
	 * Provision + start the remote backend (idempotent), open the forwarded
	 * port, and wait until it answers a health check. Any previously active
	 * connection is closed first.
	 */
	async connect(config: RemoteConnectionConfig): Promise<ActiveRemote> {
		this.clearReconnectTimer();
		const active = await this.connectOnce(config);
		this.desired = config;
		this.reconnectAttempt = 0;
		return active;
	}

	private async connectOnce(
		config: RemoteConnectionConfig,
	): Promise<ActiveRemote> {
		this.closeActive();
		const localPort = await findFreePort();
		this.setStatus(config, "connecting", localPort, null);

		let client: Client | null = null;
		let resolved: RemoteConnectionConfig = config;
		try {
			const readyClient = await this.openClient(config);
			client = readyClient;
			resolved = await this.resolveConfig(readyClient, config);
			const bundleHash = await this.provisionRemote(readyClient, resolved);
			await this.setupRemoteAgents(readyClient, resolved);
			const secret = await this.startRemoteBackend(
				readyClient,
				resolved,
				bundleHash,
			);

			const server = this.openTunnel(
				readyClient,
				localPort,
				config.remoteHostServicePort,
			);
			this.client = readyClient;
			this.tunnelServer = server;

			const healthy = await pollHealthCheck(
				`http://127.0.0.1:${localPort}`,
				secret,
				HEALTH_POLL_TIMEOUT_MS,
				() => this.client !== readyClient,
			);
			if (!healthy) {
				const logTail = await this.readRemoteLogTail(readyClient, resolved);
				throw new Error(
					`Remote host-service did not answer on the tunnel within ${HEALTH_POLL_TIMEOUT_MS}ms.${
						logTail
							? `\n\nLast lines of ${resolved.odinFolder}/host-service.log:\n${logTail}`
							: ""
					}`,
				);
			}

			// health.check is public; prove the secret before the renderer
			// gets a wall of 401s.
			const auth = await fetch(
				`http://127.0.0.1:${localPort}${REMOTE_AUTH_PROBE_PATH}`,
				{ headers: { Authorization: `Bearer ${secret}` } },
			);
			if (auth.status === 401) {
				throw new Error(
					"The remote host-service rejected this app's credentials. Restart it on the server and connect again.",
				);
			}

			// Watch for the connection dropping while we are live.
			readyClient.on("close", () => this.handleClientClosed(readyClient));
			readyClient.on("error", () => this.handleClientClosed(readyClient));

			this.active = {
				connectionId: config.id,
				name: config.name,
				host: config.host,
				localPort,
				secret,
				status: "connected",
			};
			this.setStatus(config, "connected", localPort, null);
			log.info(
				`[remote-connection] connected to ${config.host} via :${localPort}`,
			);
			return this.active;
		} catch (error) {
			if (this.client === client) {
				this.closeActive();
			} else {
				client?.end();
			}
			this.active = null;
			const message = error instanceof Error ? error.message : String(error);
			this.setStatus(config, "error", null, message);
			throw error;
		}
	}

	/** Close the local side only; the remote daemon is left running. */
	disconnect(): void {
		this.desired = null;
		this.clearReconnectTimer();
		const previous = this.active;
		this.closeActive();
		this.active = null;
		if (previous) {
			this.emitter.emit("status", {
				connectionId: previous.connectionId,
				name: previous.name,
				host: previous.host,
				status: "disconnected",
				localPort: null,
				error: null,
			} satisfies RemoteConnectionStatusEvent);
		}
	}

	// ── SSH orchestration ─────────────────────────────────────────────

	private openClient(config: RemoteConnectionConfig): Promise<Client> {
		return new Promise((resolve, reject) => {
			const client = new Client();
			let settled = false;
			// ssh2 only says "verification failed"; this says which key and why.
			let hostKeyProblem: string | null = null;
			client.on("ready", () => {
				settled = true;
				resolve(client);
			});
			client.on("error", (error) => {
				if (settled) return;
				settled = true;
				reject(hostKeyProblem ? new Error(hostKeyProblem) : error);
			});
			const hostId = `${config.host}:${config.sshPort}`;
			const hostVerifier = (key: Buffer): boolean => {
				const fingerprint = hostKeyFingerprint(key);
				const known = readKnownHosts();
				const verdict = checkHostKey(known, hostId, fingerprint);
				if (verdict === "match") return true;
				if (verdict === "new") {
					fs.mkdirSync(path.dirname(KNOWN_HOSTS_PATH), { recursive: true });
					fs.writeFileSync(
						KNOWN_HOSTS_PATH,
						JSON.stringify({ ...known, [hostId]: fingerprint }, null, 2),
						{ mode: 0o600 },
					);
					log.info(`[remote-connection] trusting ${hostId} at ${fingerprint}`);
					return true;
				}
				hostKeyProblem = `${hostId} showed a different host key (${fingerprint}, expected ${verdict.expected}). Someone may be posing as the server. If the server was rebuilt, remove its line from ${KNOWN_HOSTS_PATH} and connect again.`;
				return false;
			};
			let connectConfig: ConnectConfig;
			try {
				connectConfig = {
					host: config.host,
					port: config.sshPort,
					username: config.username,
					readyTimeout: SSH_READY_TIMEOUT_MS,
					hostVerifier,
					...this.buildAuth(config),
				};
			} catch (error) {
				reject(error);
				return;
			}
			client.connect(connectConfig);
		});
	}

	private buildAuth(config: RemoteConnectionConfig): Partial<ConnectConfig> {
		if (config.authMethod === "password") {
			if (!config.password) {
				throw new Error("A password is required for password authentication.");
			}
			return { password: config.password };
		}
		const explicit = config.sshKeyPath ? expandHome(config.sshKeyPath) : null;
		if (explicit && !fs.existsSync(explicit)) {
			throw new Error(`SSH key not found at ${explicit}`);
		}
		const keyPath = explicit ?? defaultPrivateKeyPath();
		const key = keyPath ? fs.readFileSync(keyPath) : null;
		// A key with a passphrase can't be read without it; the agent holds it
		// unlocked. Offer both, so either one gets in.
		const readable =
			key && !(utils.parseKey(key) instanceof Error) ? key : null;
		const agent = sshAgentPath();
		if (!readable && !agent) {
			throw new Error(
				key
					? `${keyPath} is protected by a passphrase. Add it to your SSH agent (ssh-add ${keyPath}) and connect again.`
					: "No SSH key found and no agent is running. Set a key path, or switch to password authentication.",
			);
		}
		return {
			...(readable ? { privateKey: readable } : {}),
			...(agent ? { agent } : {}),
		};
	}

	/**
	 * Expand a leading `~` in the odin folder to the remote home directory.
	 * The folder is quoted in shell commands (so the shell never expands `~`)
	 * and sftp cannot expand it either, so resolve it once against the real
	 * remote `$HOME`.
	 */
	private async resolveConfig(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<RemoteConnectionConfig> {
		if (!config.odinFolder.startsWith("~")) return config;
		const result = await this.exec(client, 'printf %s "$HOME"');
		const home = result.stdout.trim();
		if (!home) {
			throw new Error("Could not resolve the remote home directory.");
		}
		return {
			...config,
			odinFolder: config.odinFolder.replace(/^~(?=\/|$)/, home),
		};
	}

	/**
	 * Ship the backend bundle (entries + chunks) and migrations, and install
	 * its runtime deps for the remote's platform. Returns the bundle's content
	 * hash so the start step can tell a current daemon from a stale one.
	 */
	private async provisionRemote(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<string> {
		const backendDir = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}`;
		const migrationsSource = app.isPackaged
			? path.join(process.resourcesPath, "resources/host-migrations")
			: path.join(app.getAppPath(), "../../packages/host-service/drizzle");

		const staged = this.stageBundleFiles();
		try {
			const running = await this.exec(
				client,
				`cat ${shellQuote(`${backendDir}/.running-bundle`)} 2>/dev/null`,
			);
			// The daemon already runs exactly this bundle: nothing to copy.
			if (running.stdout.trim() !== staged.hash) {
				const remoteDirs = new Set([backendDir]);
				for (const file of staged.files) {
					remoteDirs.add(path.posix.dirname(`${backendDir}/${file.name}`));
				}
				await this.execChecked(
					client,
					`mkdir -p ${[...remoteDirs].map(shellQuote).join(" ")}`,
					"prepare the remote backend directory",
				);
				const sftp = await this.openSftp(client);
				try {
					for (const file of staged.files) {
						await this.putFile(
							sftp,
							file.localPath,
							`${backendDir}/${file.name}`,
						);
					}
					await this.putDir(
						client,
						sftp,
						migrationsSource,
						`${backendDir}/${REMOTE_MIGRATIONS_DIRNAME}`,
					);
					await this.putDir(
						client,
						sftp,
						localDbMigrationsSource(),
						`${backendDir}/${REMOTE_LOCAL_DB_MIGRATIONS_DIRNAME}`,
					);
				} finally {
					sftp.end();
				}
			}
		} finally {
			// Async: a sync recursive delete would stall the main process.
			await fs.promises
				.rm(staged.dir, { recursive: true, force: true })
				.catch(() => {
					// Temp dir - best-effort cleanup.
				});
		}

		// Every connect, before the backend starts: it cannot load without it.
		await this.writeElectronShim(client, config.odinFolder);
		await this.carryOverConnections(client, config);
		await this.execChecked(
			client,
			buildNodeInstallCommand(config.odinFolder),
			"set up Node on the server",
		);
		await this.execChecked(
			client,
			buildProvisionCommand(backendDir, REMOTE_RUNTIME_DEPS, config.odinFolder),
			"install the remote backend's npm dependencies",
		);
		return staged.hash;
	}

	/**
	 * Copy the backend bundle files out of their install location (inside
	 * app.asar when packaged) into a temp dir sftp can read. Reads go through
	 * Electron's asar-aware fs; the returned paths are real files on disk.
	 */
	private stageBundleFiles(): {
		dir: string;
		hash: string;
		files: { name: string; localPath: string }[];
	} {
		const sourceDir = __dirname;
		if (!fs.existsSync(path.join(sourceDir, REMOTE_BUNDLE_NAME))) {
			throw new Error(
				`Backend bundle not found at ${path.join(sourceDir, REMOTE_BUNDLE_NAME)}`,
			);
		}
		const names = collectBundleFiles(REMOTE_BUNDLE_ENTRIES, (rel) => {
			const source = path.join(sourceDir, rel);
			return fs.existsSync(source) ? fs.readFileSync(source, "utf8") : null;
		});
		for (const entry of REMOTE_BUNDLE_ENTRIES) {
			if (!names.includes(entry)) {
				log.warn(`[remote-connection] bundle file missing, skipping: ${entry}`);
			}
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odin-remote-"));
		const hash = createHash("sha256");
		const files = names.map((name) => {
			const content = fs.readFileSync(path.join(sourceDir, name));
			hash.update(name).update("\0").update(content);
			const localPath = path.join(dir, name);
			fs.mkdirSync(path.dirname(localPath), { recursive: true });
			fs.writeFileSync(localPath, content);
			return { name, localPath };
		});
		return { dir, hash: hash.digest("hex"), files };
	}

	/**
	 * Start the remote backend, or adopt the one already running, and return
	 * the secret it answers to.
	 */
	private async startRemoteBackend(
		client: Client,
		config: RemoteConnectionConfig,
		bundleHash: string,
	): Promise<string> {
		const bundlePath = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}/${REMOTE_BUNDLE_NAME}`;
		const migrationsDir = `${config.odinFolder}/${REMOTE_BACKEND_DIRNAME}/${REMOTE_MIGRATIONS_DIRNAME}`;
		const existing = await this.readRemoteManifest(client, config);
		const secret = randomBytes(32).toString("hex");
		const command = buildRemoteStartCommand(config, {
			existing: existing && { pid: existing.pid },
			bundleHash,
			organizationId: REMOTE_ORGANIZATION_ID,
			bundlePath,
			migrationsDir,
			hookPort: sharedEnv.DESKTOP_NOTIFICATIONS_PORT,
			hookVersion: HOOK_PROTOCOL_VERSION,
			vitePort: sharedEnv.DESKTOP_VITE_PORT,
		});
		const result = await this.execChecked(
			client,
			command,
			"start the remote host-service",
			startCommandStdin(secret, existing?.secret ?? null),
		);
		if (existing && result.stdout.includes(ALREADY_RUNNING_MARKER)) {
			log.info("[remote-connection] adopted the running remote host-service");
			return existing.secret;
		}
		return secret;
	}

	/** pid + secret of the daemon a previous connect left running, if any. */
	private async readRemoteManifest(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<{ secret: string; pid: number } | null> {
		const manifestPath = `${config.odinFolder}/host/${REMOTE_ORGANIZATION_ID}/manifest.json`;
		const result = await this.exec(
			client,
			`cat ${shellQuote(manifestPath)} 2>/dev/null`,
		);
		try {
			const data = JSON.parse(result.stdout) as {
				pid?: unknown;
				authToken?: unknown;
			};
			if (
				typeof data.authToken === "string" &&
				data.authToken &&
				Number.isInteger(data.pid)
			) {
				return { secret: data.authToken, pid: data.pid as number };
			}
		} catch {
			// No manifest yet, or a torn write - start fresh.
		}
		return null;
	}

	private async readRemoteLogTail(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<string> {
		try {
			const result = await this.exec(
				client,
				`tail -n ${REMOTE_LOG_TAIL_LINES} ${shellQuote(`${config.odinFolder}/host-service.log`)} 2>/dev/null`,
			);
			return result.stdout.trim();
		} catch {
			return "";
		}
	}

	private openTunnel(
		client: Client,
		localPort: number,
		remotePort: number,
	): net.Server {
		const server = net.createServer((socket) => {
			client.forwardOut(
				socket.remoteAddress ?? "127.0.0.1",
				socket.remotePort ?? 0,
				"127.0.0.1",
				remotePort,
				(error, stream) => {
					if (error) {
						socket.destroy();
						return;
					}
					socket.pipe(stream).pipe(socket);
					stream.on("error", () => socket.destroy());
					socket.on("error", () => stream.end());
				},
			);
		});
		server.on("error", (error) => {
			log.warn(`[remote-connection] tunnel server error: ${error.message}`);
		});
		server.listen(localPort, "127.0.0.1");
		return server;
	}

	private handleClientClosed(client: Client): void {
		if (this.client !== client) return;
		const dropped = this.active;
		this.closeActive();
		this.active = null;
		if (dropped) {
			this.emitter.emit("status", {
				connectionId: dropped.connectionId,
				name: dropped.name,
				host: dropped.host,
				status: "error",
				localPort: null,
				error: "SSH connection closed unexpectedly.",
			} satisfies RemoteConnectionStatusEvent);
		}
		if (this.desired) this.scheduleReconnect();
	}

	// ── Connections on the server ──────────────────────────────────────

	/** The electron stand-in the server-side connection modules load (electron-shim.ts). */
	private async writeElectronShim(
		client: Client,
		odinFolder: string,
	): Promise<void> {
		const dir = `${odinFolder}/${REMOTE_ELECTRON_SHIM_DIR}`;
		await this.execChecked(
			client,
			`mkdir -p ${shellQuote(dir)}`,
			"create the remote shims folder",
		);
		const sftp = await this.openSftp(client);
		try {
			await this.writeRemoteFile(
				sftp,
				`${dir}/index.js`,
				ELECTRON_SHIM_SOURCE,
				0o644,
			);
			await this.writeRemoteFile(
				sftp,
				`${dir}/package.json`,
				ELECTRON_SHIM_PACKAGE_JSON,
				0o644,
			);
		} finally {
			sftp.end();
		}
	}

	/**
	 * On the first connect, bring the laptop's connections along: the server
	 * gets a copy of odin.json (profiles, tokens, OAuth apps) and owns it from
	 * then on - it refreshes the rotating Jira/GitHub tokens, so the laptop's
	 * copy must never be pushed over it again.
	 */
	private async carryOverConnections(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<void> {
		const remotePath = `${config.odinFolder}/odin.json`;
		const exists = await this.exec(client, `test -e ${shellQuote(remotePath)}`);
		if (exists.code === 0) return;
		const localPath = odinConfigPath();
		if (!fs.existsSync(localPath)) return;
		const sftp = await this.openSftp(client);
		try {
			await this.writeRemoteFile(
				sftp,
				remotePath,
				await fs.promises.readFile(localPath, "utf8"),
				0o600,
			);
			log.info(
				`[remote-connection] carried the laptop's connections over to ${remotePath}`,
			);
		} finally {
			sftp.end();
		}
	}

	// ── Agent setup on the server ──────────────────────────────────────

	/**
	 * Install Odin's hook scripts, `claude` wrapper and Claude hooks on the
	 * server, so remote sessions report Working / Needs you / Done like local
	 * ones. Best-effort: sessions still run without it, so a failure here is
	 * logged, not fatal.
	 */
	private async setupRemoteAgents(
		client: Client,
		config: RemoteConnectionConfig,
	): Promise<void> {
		try {
			const files = buildRemoteAgentFiles(config.odinFolder);
			const dirs = [
				...new Set(files.map((file) => path.posix.dirname(file.path))),
			];
			await this.execChecked(
				client,
				`mkdir -p ${dirs.map(shellQuote).join(" ")}`,
				"create the remote hook folders",
			);
			const sftp = await this.openSftp(client);
			try {
				for (const file of files) {
					await this.writeRemoteFile(sftp, file.path, file.content, file.mode);
				}
			} finally {
				sftp.end();
			}

			const home = (await this.exec(client, 'printf %s "$HOME"')).stdout.trim();
			if (home) {
				const settingsPath = `${home}/.claude/settings.json`;
				const current = await this.exec(
					client,
					`cat ${shellQuote(settingsPath)} 2>/dev/null`,
				);
				const merged = mergeRemoteClaudeSettings(
					current.stdout,
					config.odinFolder,
				);
				if (merged === null) {
					log.warn(
						`[remote-connection] ${settingsPath} is not a JSON object; left alone, so remote sessions report no status`,
					);
				} else if (merged !== current.stdout) {
					await this.execChecked(
						client,
						`mkdir -p ${shellQuote(`${home}/.claude`)}`,
						"create ~/.claude on the remote",
					);
					const settingsSftp = await this.openSftp(client);
					try {
						await this.writeRemoteFile(
							settingsSftp,
							settingsPath,
							merged,
							0o644,
						);
					} finally {
						settingsSftp.end();
					}
				}
			}

			const install = await this.exec(
				client,
				buildClaudeInstallCommand(config.odinFolder),
			);
			if (install.code !== 0) {
				log.warn(
					`[remote-connection] installing Claude Code on the server failed: ${(install.stderr || install.stdout).trim()}`,
				);
			}
		} catch (error) {
			log.warn(
				`[remote-connection] agent setup on the server failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private writeRemoteFile(
		sftp: SFTPWrapper,
		remotePath: string,
		content: string,
		mode: number,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			sftp.writeFile(remotePath, content, { mode }, (error) => {
				if (error) {
					reject(new Error(`Failed to write ${remotePath}: ${error.message}`));
					return;
				}
				// writeFile's mode only applies on create; make it stick.
				sftp.chmod(remotePath, mode, () => resolve());
			});
		});
	}

	// ── Reconnect ──────────────────────────────────────────────────────

	private attemptReconnect(): void {
		const config = this.desired;
		if (!config) return;
		this.connectOnce(config)
			.then(() => {
				this.reconnectAttempt = 0;
			})
			.catch((error) => {
				log.warn(
					`[remote-connection] reconnect to ${config.host} failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				this.scheduleReconnect();
			});
	}

	private scheduleReconnect(): void {
		if (!this.desired || this.reconnectTimer) return;
		const delay = Math.min(
			RECONNECT_MAX_DELAY_MS,
			RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
		);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.attemptReconnect();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private closeActive(): void {
		if (this.tunnelServer) {
			try {
				this.tunnelServer.close();
			} catch {
				// Best-effort.
			}
			this.tunnelServer = null;
		}
		if (this.client) {
			try {
				this.client.end();
			} catch {
				// Best-effort.
			}
			this.client = null;
		}
	}

	// ── ssh2 primitives ───────────────────────────────────────────────

	private exec(
		client: Client,
		command: string,
		stdin?: string,
	): Promise<CommandResult> {
		return new Promise((resolve, reject) => {
			client.exec(command, (error, stream) => {
				if (error) {
					reject(error);
					return;
				}
				if (stdin !== undefined) stream.end(stdin);
				let stdout = "";
				let stderr = "";
				stream
					.on("close", (code: number | null) =>
						resolve({ code: code ?? null, stdout, stderr }),
					)
					.on("data", (chunk: Buffer) => {
						stdout += chunk.toString();
					});
				stream.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
			});
		});
	}

	private async execChecked(
		client: Client,
		command: string,
		description: string,
		stdin?: string,
	): Promise<CommandResult> {
		const result = await this.exec(client, command, stdin);
		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout).trim();
			throw new Error(`Failed to ${description}${detail ? `: ${detail}` : ""}`);
		}
		return result;
	}

	private openSftp(client: Client): Promise<SFTPWrapper> {
		return new Promise((resolve, reject) => {
			client.sftp((error, sftp) => {
				if (error) reject(error);
				else resolve(sftp);
			});
		});
	}

	private putFile(
		sftp: SFTPWrapper,
		localPath: string,
		remotePath: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			sftp.fastPut(localPath, remotePath, (error) => {
				if (error) {
					reject(
						new Error(
							`Failed to copy ${path.basename(localPath)} to the remote: ${error.message}`,
						),
					);
				} else {
					resolve();
				}
			});
		});
	}

	/** Recursively copy a local directory to the remote over sftp. */
	private async putDir(
		client: Client,
		sftp: SFTPWrapper,
		localDir: string,
		remoteDir: string,
	): Promise<void> {
		const files: { abs: string; rel: string }[] = [];
		const walk = (dir: string, rel: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const abs = path.join(dir, entry.name);
				const relPath = rel ? `${rel}/${entry.name}` : entry.name;
				if (entry.isDirectory()) walk(abs, relPath);
				else if (entry.isFile()) files.push({ abs, rel: relPath });
			}
		};
		walk(localDir, "");
		const remoteDirs = new Set<string>([remoteDir]);
		for (const file of files) {
			const parent = file.rel.includes("/")
				? `${remoteDir}/${file.rel.slice(0, file.rel.lastIndexOf("/"))}`
				: remoteDir;
			remoteDirs.add(parent);
		}
		await this.execChecked(
			client,
			`mkdir -p ${[...remoteDirs].map(shellQuote).join(" ")}`,
			"create the remote migrations directory",
		);
		for (const file of files) {
			await this.putFile(sftp, file.abs, `${remoteDir}/${file.rel}`);
		}
	}

	private setStatus(
		config: RemoteConnectionConfig,
		status: RemoteConnectionStatus,
		localPort: number | null,
		error: string | null,
	): void {
		this.emitter.emit("status", {
			connectionId: config.id,
			name: config.name,
			host: config.host,
			status,
			localPort,
			error,
		} satisfies RemoteConnectionStatusEvent);
	}
}

let singleton: RemoteConnectionManager | null = null;

export function getRemoteConnectionManager(): RemoteConnectionManager {
	if (!singleton) singleton = new RemoteConnectionManager();
	return singleton;
}
