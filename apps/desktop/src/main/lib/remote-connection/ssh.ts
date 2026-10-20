import { createHash } from "node:crypto";
import path from "node:path";
import type { RemoteConnectionConfig, TestConnectionResult } from "./types";

/** Markers the remote probe prints so we can parse its result unambiguously. */
export const FOLDER_OK_MARKER = "ODIN_FOLDER_OK";
export const PLATFORM_MARKER = "ODIN_PLATFORM";

/**
 * The Node the backend runs on, downloaded into the odin folder by
 * {@link buildNodeInstallCommand}: the server needs nothing installed, and the
 * native modules npm builds always match the Node that loads them.
 */
export const REMOTE_NODE_VERSION = "22.12.0";

/** Node's Linux build names, by `uname -m`. */
const NODE_ARCH: Record<string, string> = {
	x86_64: "x64",
	amd64: "x64",
	aarch64: "arm64",
	arm64: "arm64",
};

/**
 * Single-quote a string for a POSIX shell: wrap in single quotes and escape any
 * embedded single quote as '\''. Safe for arbitrary paths run on the remote.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Remote probe for Test-connection: create the odin folder and report the
 * server's OS and CPU. Prints stable markers the parser keys off.
 */
export function buildTestCommand(config: RemoteConnectionConfig): string {
	const folder = shellQuote(config.odinFolder);
	return [
		`mkdir -p ${folder} && printf '%s\\n' ${shellQuote(FOLDER_OK_MARKER)}`,
		`printf '%s %s %s\\n' ${shellQuote(PLATFORM_MARKER)} "$(uname -s)" "$(uname -m)"`,
	].join("; ");
}

/** Parse the probe's stdout into a structured, UI-friendly result. */
export function parseTestOutput(
	stdout: string,
	reachable: boolean,
	errorText = "",
): TestConnectionResult {
	const folderReady = stdout.includes(FOLDER_OK_MARKER);
	const [os = "", arch = ""] =
		stdout
			.split("\n")
			.find((line) => line.startsWith(PLATFORM_MARKER))
			?.slice(PLATFORM_MARKER.length)
			.trim()
			.split(/\s+/) ?? [];
	const platform = os ? `${os} ${arch}`.trim() : null;
	const fail = (message: string): TestConnectionResult => ({
		ok: false,
		reachable,
		platform,
		folderReady,
		message,
	});

	if (!reachable) {
		return fail(errorText.trim() || "Could not reach the host over SSH.");
	}
	// The start command uses setsid and /proc, and Odin ships Node's Linux build.
	if (os !== "Linux") {
		return fail(
			`Connected, but the server runs ${os || "an unknown OS"}. Odin's backend runs on Linux servers only.`,
		);
	}
	if (!NODE_ARCH[arch]) {
		return fail(
			`Connected, but the server's CPU (${arch || "unknown"}) is not one Odin can run on. It needs x86_64 or arm64.`,
		);
	}
	if (!folderReady)
		return fail("Connected, but the odin folder could not be created.");
	return {
		ok: true,
		reachable: true,
		platform,
		folderReady: true,
		message: `Connected to ${platform}. The odin folder is ready, and Odin sets up its own Node there on the first connect.`,
	};
}

/**
 * Remote command that puts Node {@link REMOTE_NODE_VERSION} under
 * `<folder>/node`, once: the official Linux build for the server's CPU,
 * fetched with curl or wget. Exits non-zero with a plain reason when the
 * server is not Linux, has an unknown CPU, or the download fails.
 */
export function buildNodeInstallCommand(folder: string): string {
	const dir = `${folder}/node`;
	const q = shellQuote;
	const v = REMOTE_NODE_VERSION;
	const arches = Object.entries(NODE_ARCH)
		.map(([machine, node]) => `${machine}) a=${node};;`)
		.join(" ");
	return [
		`if [ "$(cat ${q(`${dir}/.version`)} 2>/dev/null)" != ${q(v)} ]; then`,
		`[ "$(uname -s)" = Linux ] || { echo "Odin's backend runs on Linux servers only, this one runs $(uname -s)." >&2; exit 3; };`,
		`case "$(uname -m)" in ${arches} *) echo "No Node build for this CPU ($(uname -m)); Odin needs x86_64 or arm64." >&2; exit 3;; esac;`,
		`url=https://nodejs.org/dist/v${v}/node-v${v}-linux-$a.tar.gz;`,
		`rm -rf ${q(`${dir}.tmp`)} && mkdir -p ${q(`${dir}.tmp`)} &&`,
		`{ if command -v curl >/dev/null 2>&1; then curl -fsSL "$url"; elif command -v wget >/dev/null 2>&1; then wget -qO- "$url"; else echo "The server has neither curl nor wget to download Node with." >&2; exit 3; fi; }`,
		`| tar -xz -C ${q(`${dir}.tmp`)} --strip-components=1 &&`,
		`[ -x ${q(`${dir}.tmp/bin/node`)} ] || { echo "Downloading Node from $url failed." >&2; exit 3; };`,
		`rm -rf ${q(dir)} && mv ${q(`${dir}.tmp`)} ${q(dir)} && printf '%s' ${q(v)} > ${q(`${dir}/.version`)};`,
		"fi",
	].join(" ");
}

/** Puts the odin folder's own Node first on PATH for the rest of a command. */
export function remoteNodePath(folder: string): string {
	return `export PATH=${shellQuote(`${folder}/node/bin`)}:"$PATH"; `;
}

/**
 * Packages the backend bundle loads from node_modules at runtime: the main
 * build's externals (runtime-dependencies.ts) that host-service reaches, plus
 * what it loads through createRequire (@xterm/headless in the terminal mode
 * tracker, the ACP adapter for sessions). Pinned to the app's own versions so
 * native ABIs match - ssh.test.ts checks them against the package.json files.
 */
export const REMOTE_RUNTIME_DEPS = [
	"better-sqlite3@12.6.2",
	"node-pty@1.2.0-beta.14",
	"@parcel/watcher@2.5.6",
	"mastracode@0.18.1",
	"@xterm/headless@6.1.0-beta.289",
	"@agentclientprotocol/claude-agent-acp@0.56.0",
];

/**
 * Installed only on an arm64 server: fastembed (under mastracode) pins
 * @anush008/tokenizers 0.0.0, which has no Linux arm64 binding, so mastracode
 * failed to load there. host-service declares the 0.6.0 binding as optional
 * for the same reason. npm refuses it on any other CPU.
 */
export const REMOTE_ARM64_DEPS = ["@anush008/tokenizers-linux-arm64-gnu@0.6.0"];

/** Beside the backend bundle: the desktop local DB's migrations. */
export const REMOTE_LOCAL_DB_MIGRATIONS_DIRNAME = "local-db-migrations";
/**
 * Where the electron stand-in lives: the odin folder's own node_modules, one
 * level above the backend, so both require() and import() find it walking up
 * from the bundle, and the backend's npm install never prunes it.
 */
export const REMOTE_ELECTRON_SHIM_DIR = "node_modules/electron";

export const ALREADY_RUNNING_MARKER = "ODIN_ALREADY_RUNNING";
export const STARTED_MARKER = "ODIN_STARTED";

/**
 * Collect the bundle entry files plus every chunk they load, transitively.
 * electron-vite code-splits the main build, so host-service.js is only a
 * shell that `require`s `./chunks/*.js` - shipping it alone fails on the
 * remote with "Cannot find module './chunks/...'". Chunk requires are always
 * emitted as literal relative `require("./x.js")` calls, so a scan is exact.
 * Returns paths relative to the bundle directory, POSIX-separated.
 */
export function collectBundleFiles(
	entries: string[],
	readFile: (relPath: string) => string | null,
): string[] {
	const seen = new Set<string>();
	const queue = [...entries];
	const relativeRequire = /require\("(\.\/[^"]+\.js)"\)/g;
	while (queue.length > 0) {
		const file = queue.shift() as string;
		if (seen.has(file)) continue;
		const source = readFile(file);
		if (source === null) continue;
		seen.add(file);
		const dir = path.posix.dirname(file);
		for (const match of source.matchAll(relativeRequire)) {
			queue.push(path.posix.normalize(path.posix.join(dir, match[1])));
		}
	}
	return [...seen].sort();
}

/**
 * Remote command that installs the backend's runtime npm deps when the set
 * differs from the last install. The marker holds the exact dep list, so a
 * new app version with a changed list reinstalls instead of trusting a stale
 * `.provisioned` file from an older one.
 */
export function buildProvisionCommand(
	backendDir: string,
	deps: string[],
	folder: string,
): string {
	const marker = shellQuote(`${backendDir}/.provisioned`);
	const spec = [...deps, ...REMOTE_ARM64_DEPS].join(" ");
	// npm_config_libc=glibc: without it prebuild-install reports an empty libc
	// and misses the prebuilt binary, falling back to a source compile that
	// needs a full C/C++ toolchain.
	return [
		remoteNodePath(folder).trim(),
		`if [ "$(cat ${marker} 2>/dev/null)" != ${shellQuote(spec)} ]; then`,
		`cd ${shellQuote(backendDir)}`,
		`&& printf '%s' '{"name":"odin-remote-backend","private":true}' > package.json`,
		`&& case "$(uname -m)" in aarch64|arm64) arm64=${shellQuote(REMOTE_ARM64_DEPS.join(" "))};; *) arm64="";; esac`,
		`&& npm_config_libc=glibc npm install --no-audit --no-fund --loglevel=error ${deps.map(shellQuote).join(" ")} $arm64`,
		`&& printf '%s' ${shellQuote(spec)} > ${marker}; fi`,
	].join(" ");
}

/**
 * Remote command to ensure the backend is running, then exit.
 *
 * It adopts a daemon left running by an earlier connect (agents outlive the
 * laptop) only when it answers a health check with that daemon's own secret,
 * read from its manifest, AND it runs the bundle we just shipped. Otherwise
 * the old daemon - stale code, or a secret we can no longer present - is
 * stopped first so the new one can bind the port. Prints
 * {@link ALREADY_RUNNING_MARKER} or {@link STARTED_MARKER}; the caller uses
 * the matching secret. Env is inlined so we do not depend on the remote's
 * login profile.
 */
export function buildRemoteStartCommand(
	config: RemoteConnectionConfig,
	params: {
		/** Pid from the remote manifest of a previous daemon. */
		existing: { pid: number } | null;
		/** Content hash of the shipped bundle; a change forces a restart. */
		bundleHash: string;
		organizationId: string;
		bundlePath: string;
		migrationsDir: string;
		hookPort: number;
		hookVersion: string;
		vitePort: number;
	},
): string {
	const folder = config.odinFolder;
	const manifestDir = `${folder}/host/${params.organizationId}`;
	const env = [
		`ODIN_HOME_DIR=${shellQuote(folder)}`,
		`ORGANIZATION_ID=${shellQuote(params.organizationId)}`,
		`HOST_SERVICE_SECRET="$ODIN_NEW_SECRET"`,
		`HOST_SERVICE_PORT=${shellQuote(String(config.remoteHostServicePort))}`,
		`HOST_DB_PATH=${shellQuote(`${manifestDir}/host.db`)}`,
		`HOST_MIGRATIONS_FOLDER=${shellQuote(params.migrationsDir)}`,
		// Required by the desktop host-service env schema (CORS allowlist).
		`DESKTOP_VITE_PORT=${shellQuote(String(params.vitePort))}`,
		`ODIN_AGENT_HOOK_PORT=${shellQuote(String(params.hookPort))}`,
		`ODIN_AGENT_HOOK_VERSION=${shellQuote(params.hookVersion)}`,
		// The connections run here too (main/odin-core): the server's own
		// odin.json and local DB, and the electron stand-in their modules load.
		"ODIN_REMOTE_CORE=1",
		`ODIN_CONFIG_PATH=${shellQuote(`${folder}/odin.json`)}`,
		`ODIN_LOCAL_DB_MIGRATIONS=${shellQuote(`${folder}/backend/${REMOTE_LOCAL_DB_MIGRATIONS_DIRNAME}`)}`,
		"NODE_ENV=production",
		// The laptop's clock: automations' cron and the Night Agent's window
		// are in your time, wherever the server is.
		...laptopTimeZone(),
	].join(" ");
	const stamp = shellQuote(`${folder}/backend/.running-bundle`);
	const hash = shellQuote(params.bundleHash);
	const log = shellQuote(`${folder}/host-service.log`);
	// Another backend of ours on this port - one a connect with a different
	// Odin folder left running - would keep the port, the new one would die
	// on EADDRINUSE, and the auth check would meet the old one's secret.
	// Matched by the port in its own environment, so nothing else is touched;
	// the sessions live in the pty-daemon and outlive it.
	const portEnv = shellQuote(
		`HOST_SERVICE_PORT=${config.remoteHostServicePort}`,
	);
	const stopOthers = [
		`for p in $(pgrep -u "$(id -u)" -f 'host-service[.]js'); do`,
		`tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qxF -- ${portEnv} || continue;`,
		`kill $p 2>/dev/null;`,
		`for i in $(seq 1 40); do kill -0 $p 2>/dev/null || break; sleep 0.25; done;`,
		`kill -9 $p 2>/dev/null; done;`,
	].join(" ");
	const start = [
		stopOthers,
		`cd ${shellQuote(folder)}`,
		`&& printf '%s' ${hash} > ${stamp}`,
		`&& { ${env} setsid nohup node ${shellQuote(params.bundlePath)} >> ${log} 2>&1 < /dev/null & }`,
		`&& echo ${STARTED_MARKER}`,
	].join(" ");
	const prelude = `${READ_SECRETS}${remoteNodePath(folder)}`;
	if (!params.existing) return `${prelude}${start}`;

	const { pid } = params.existing;
	const healthProbe = buildRemoteHealthProbe(config.remoteHostServicePort);
	// Only signal the pid if it is still our node process (pids get reused),
	// then wait out its graceful shutdown so the port is free.
	const stopOld = [
		`if tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null | grep -qF -- ${shellQuote(params.bundlePath)}; then`,
		`kill ${pid} 2>/dev/null;`,
		`for i in $(seq 1 40); do kill -0 ${pid} 2>/dev/null || break; sleep 0.25; done;`,
		`kill -9 ${pid} 2>/dev/null; fi`,
	].join(" ");
	return `${prelude}if [ "$(cat ${stamp} 2>/dev/null)" = ${hash} ] && ${healthProbe}; then echo ${ALREADY_RUNNING_MARKER}; else ${stopOld}; ${start}; fi`;
}

/**
 * The secrets reach the remote on the command's stdin, never in the command
 * text: the shell that runs it shows its whole command line to every user on
 * the server, while a process's environment is readable only by its owner.
 * Line 1 is the new daemon's secret, line 2 the previous daemon's.
 */
const READ_SECRETS =
	"IFS= read -r ODIN_NEW_SECRET; IFS= read -r ODIN_OLD_SECRET; ";

/** stdin for {@link buildRemoteStartCommand}: the secrets, one per line. */
export function startCommandStdin(
	secret: string,
	existingSecret: string | null,
): string {
	return `${secret}\n${existingSecret ?? ""}\n`;
}

/**
 * A protected, cheap tRPC query. health.check is a publicProcedure and answers
 * 200 to any token, so it cannot tell whether we still hold the daemon's
 * secret; this one returns 401 when we do not.
 */
export const REMOTE_AUTH_PROBE_PATH = "/trpc/settings.branchPrefix.get";

/**
 * A `node -e` one-liner that exits 0 only when the local host-service answers
 * an authenticated query with 200 for the previous daemon's secret. Used remotely (over the
 * configured port) to decide whether the running daemon can be adopted. Node
 * is a hard prerequisite anyway.
 */
export function buildRemoteHealthProbe(port: number): string {
	const script = [
		"const http=require('http');",
		`const r=http.get({host:'127.0.0.1',port:${port},path:'${REMOTE_AUTH_PROBE_PATH}',headers:{Authorization:'Bearer '+process.env.ODIN_HEALTH_SECRET},timeout:2000},`,
		"res=>process.exit(res.statusCode===200?0:1));",
		"r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)});",
	].join("");
	// $ODIN_OLD_SECRET was read from stdin by the start command.
	return `ODIN_HEALTH_SECRET="$ODIN_OLD_SECRET" node -e ${shellQuote(script)}`;
}

/** OpenSSH-style fingerprint of a raw host key: `SHA256:<base64, no padding>`. */
export function hostKeyFingerprint(key: Buffer): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Trust on first use, like OpenSSH's known_hosts: the first key a host shows
 * is kept, and a different key later is refused - otherwise anyone between
 * the laptop and the server could pose as it and receive the password, the
 * backend and its secret.
 */
export function checkHostKey(
	known: Record<string, string>,
	hostId: string,
	fingerprint: string,
): "match" | "new" | { expected: string } {
	const expected = known[hostId];
	if (!expected) return "new";
	return expected === fingerprint ? "match" : { expected };
}

/** `TZ=<zone>` for the server process, from this machine's own zone. */
function laptopTimeZone(): string[] {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return zone && /^[\w+/-]+$/.test(zone) ? [`TZ=${shellQuote(zone)}`] : [];
}
