import { describe, expect, it } from "bun:test";
import hostServicePackage from "../../../../../../packages/host-service/package.json";
import desktopPackage from "../../../../package.json";
import {
	ALREADY_RUNNING_MARKER,
	buildNodeInstallCommand,
	buildProvisionCommand,
	buildRemoteHealthProbe,
	buildRemoteStartCommand,
	buildTestCommand,
	checkHostKey,
	collectBundleFiles,
	FOLDER_OK_MARKER,
	hostKeyFingerprint,
	PLATFORM_MARKER,
	parseTestOutput,
	REMOTE_ARM64_DEPS,
	REMOTE_NODE_VERSION,
	REMOTE_RUNTIME_DEPS,
	STARTED_MARKER,
	shellQuote,
	startCommandStdin,
} from "./ssh";
import type { RemoteConnectionConfig } from "./types";

const config: RemoteConnectionConfig = {
	id: "conn-1",
	name: "Build box",
	host: "10.0.0.42",
	sshPort: 2222,
	username: "ubuntu",
	authMethod: "key",
	sshKeyPath: "/home/me/.ssh/id_ed25519",
	password: null,
	odinFolder: "/srv/odin",
	remoteHostServicePort: 48000,
};

describe("shellQuote", () => {
	it("wraps a plain value in single quotes", () => {
		expect(shellQuote("/srv/odin")).toBe("'/srv/odin'");
	});

	it("escapes embedded single quotes so injection is impossible", () => {
		expect(shellQuote("a'b")).toBe("'a'\\''b'");
		// A quote-and-command attempt stays inside the quoting.
		expect(shellQuote("x'; rm -rf /")).toBe("'x'\\''; rm -rf /'");
	});
});

describe("buildTestCommand + parseTestOutput", () => {
	it("creates the folder and reports the OS and CPU", () => {
		const command = buildTestCommand(config);
		expect(command).toContain("mkdir -p '/srv/odin'");
		expect(command).toContain('"$(uname -s)" "$(uname -m)"');
		expect(command).not.toContain("command -v node");
	});

	it("passes a Linux server on a CPU Node builds for", () => {
		for (const arch of ["x86_64", "aarch64"]) {
			const stdout = `${FOLDER_OK_MARKER}\n${PLATFORM_MARKER} Linux ${arch}\n`;
			expect(parseTestOutput(stdout, true)).toMatchObject({
				ok: true,
				reachable: true,
				platform: `Linux ${arch}`,
				folderReady: true,
			});
		}
	});

	it("says a macOS server can't run the backend", () => {
		const result = parseTestOutput(
			`${FOLDER_OK_MARKER}\n${PLATFORM_MARKER} Darwin arm64\n`,
			true,
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("Linux servers only");
	});

	it("says which CPU is unsupported", () => {
		const result = parseTestOutput(
			`${FOLDER_OK_MARKER}\n${PLATFORM_MARKER} Linux armv7l\n`,
			true,
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("armv7l");
	});

	it("reports unreachable with the error text when ssh failed", () => {
		const result = parseTestOutput(
			"",
			false,
			"All configured authentication methods failed",
		);
		expect(result.ok).toBe(false);
		expect(result.reachable).toBe(false);
		expect(result.message).toContain("authentication");
	});
});

describe("buildRemoteStartCommand", () => {
	const startParams = {
		existing: null,
		bundleHash: "abc123",
		organizationId: "remote",
		bundlePath: "/srv/odin/backend/host-service.js",
		migrationsDir: "/srv/odin/backend/host-migrations",
		hookPort: 51741,
		hookVersion: "2",
		vitePort: 5173,
	};

	it("starts detached with the backend env inlined", () => {
		const command = buildRemoteStartCommand(config, startParams);
		expect(command).toContain(
			"setsid nohup node '/srv/odin/backend/host-service.js'",
		);
		expect(command).toContain("ODIN_HOME_DIR='/srv/odin'");
		expect(command).toContain('HOST_SERVICE_SECRET="$ODIN_NEW_SECRET"');
		expect(command).toContain("HOST_SERVICE_PORT='48000'");
		expect(command).toContain("< /dev/null &");
		expect(command).toContain(STARTED_MARKER);
	});

	it("passes every var the desktop host-service env schema requires", () => {
		const command = buildRemoteStartCommand(config, startParams);
		for (const name of [
			"HOST_DB_PATH",
			"HOST_MIGRATIONS_FOLDER",
			"HOST_SERVICE_SECRET",
			"HOST_SERVICE_PORT",
			"ORGANIZATION_ID",
			"DESKTOP_VITE_PORT",
		]) {
			expect(command).toContain(`${name}=`);
		}
	});

	it("records the bundle hash it started", () => {
		const command = buildRemoteStartCommand(config, startParams);
		expect(command).toContain(
			"printf '%s' 'abc123' > '/srv/odin/backend/.running-bundle'",
		);
	});

	it("starts without probing when no previous daemon is known", () => {
		const command = buildRemoteStartCommand(config, startParams);
		expect(command).not.toContain(ALREADY_RUNNING_MARKER);
		// No pid of its own to stop - only whatever of ours holds its port.
		expect(command).not.toMatch(/kill \d/);
	});

	it("frees its port from a backend another Odin folder left running", () => {
		const command = buildRemoteStartCommand(config, startParams);
		// Ours only (this user's host-service processes), and only the one whose
		// own environment says it serves this port.
		expect(command).toContain(`pgrep -u "$(id -u)" -f 'host-service[.]js'`);
		expect(command).toContain("grep -qxF -- 'HOST_SERVICE_PORT=48000'");
		expect(command.indexOf("HOST_SERVICE_PORT=48000'")).toBeLessThan(
			command.indexOf("setsid nohup node"),
		);
	});

	it("adopts a previous daemon only on the same bundle and its own secret", () => {
		const command = buildRemoteStartCommand(config, {
			...startParams,
			existing: { pid: 4242 },
		});
		expect(command).toContain(
			"; if [ \"$(cat '/srv/odin/backend/.running-bundle'",
		);
		expect(command).toContain("= 'abc123' ] &&");
		expect(command).toContain('ODIN_HEALTH_SECRET="$ODIN_OLD_SECRET"');
		expect(command).toContain(ALREADY_RUNNING_MARKER);
	});

	it("stops the previous daemon, by verified pid, before starting anew", () => {
		const command = buildRemoteStartCommand(config, {
			...startParams,
			existing: { pid: 4242 },
		});
		const elseBranch = command.slice(command.indexOf("; else "));
		expect(elseBranch).toContain("/proc/4242/cmdline");
		expect(elseBranch).toContain(
			"grep -qF -- '/srv/odin/backend/host-service.js'",
		);
		expect(elseBranch.indexOf("kill 4242")).toBeLessThan(
			elseBranch.indexOf("setsid"),
		);
		expect(elseBranch).toContain('HOST_SERVICE_SECRET="$ODIN_NEW_SECRET"');
	});

	it("reads both secrets from stdin before it uses them", () => {
		for (const existing of [null, { pid: 4242 }]) {
			const command = buildRemoteStartCommand(config, {
				...startParams,
				existing,
			});
			expect(
				command.startsWith(
					"IFS= read -r ODIN_NEW_SECRET; IFS= read -r ODIN_OLD_SECRET; ",
				),
			).toBe(true);
		}
		expect(startCommandStdin("new", "old")).toBe("new\nold\n");
		expect(startCommandStdin("new", null)).toBe("new\n\n");
	});
});

describe("host key pinning", () => {
	it("trusts a new host, accepts its key again, refuses a changed one", () => {
		const known = { "srv:22": "SHA256:aaa" };
		expect(checkHostKey(known, "other:22", "SHA256:zzz")).toBe("new");
		expect(checkHostKey(known, "srv:22", "SHA256:aaa")).toBe("match");
		expect(checkHostKey(known, "srv:22", "SHA256:bbb")).toEqual({
			expected: "SHA256:aaa",
		});
	});

	it("fingerprints like OpenSSH: SHA256, base64, no padding", () => {
		const fingerprint = hostKeyFingerprint(Buffer.from("key"));
		expect(fingerprint.startsWith("SHA256:")).toBe(true);
		expect(fingerprint.endsWith("=")).toBe(false);
	});
});

describe("collectBundleFiles", () => {
	const files: Record<string, string> = {
		"host-service.js": `const a = require("./chunks/a-1.js");\nconst http = require("node:http");`,
		"host-worker.js": `require("./chunks/b-2.js");`,
		"chunks/a-1.js": `require("./shared-3.js"); require("better-sqlite3");`,
		"chunks/b-2.js": `require("./shared-3.js");`,
		"chunks/shared-3.js": `Promise.resolve().then(() => require("./lazy-4.js"));`,
		"chunks/lazy-4.js": "module.exports = 1;",
		"chunks/unused-5.js": "module.exports = 2;",
	};
	const read = (rel: string) => files[rel] ?? null;

	it("follows chunk requires transitively, relative to each file", () => {
		expect(
			collectBundleFiles(["host-service.js", "host-worker.js"], read),
		).toEqual([
			"chunks/a-1.js",
			"chunks/b-2.js",
			"chunks/lazy-4.js",
			"chunks/shared-3.js",
			"host-service.js",
			"host-worker.js",
		]);
	});

	it("skips missing entries instead of throwing", () => {
		expect(collectBundleFiles(["pty-daemon.js"], read)).toEqual([]);
	});
});

describe("buildProvisionCommand", () => {
	it("reinstalls when the marker does not hold this exact dep list", () => {
		const command = buildProvisionCommand(
			"/srv/odin/backend",
			["a@1", "@b/c@2"],
			"/srv/odin",
		);
		expect(command).toContain(
			"if [ \"$(cat '/srv/odin/backend/.provisioned' 2>/dev/null)\" != 'a@1 @b/c@2 @anush008/tokenizers-linux-arm64-gnu@0.6.0' ]",
		);
		expect(command).toContain(
			"npm install --no-audit --no-fund --loglevel=error 'a@1' '@b/c@2'",
		);
		expect(command).toContain(
			"printf '%s' 'a@1 @b/c@2 @anush008/tokenizers-linux-arm64-gnu@0.6.0' > '/srv/odin/backend/.provisioned'",
		);
	});
});

describe("REMOTE_RUNTIME_DEPS", () => {
	it("pins each package to the version the app itself bundles against", () => {
		const declared: Record<string, string> = {
			...hostServicePackage.dependencies,
			...hostServicePackage.optionalDependencies,
			...desktopPackage.dependencies,
		};
		for (const spec of [...REMOTE_RUNTIME_DEPS, ...REMOTE_ARM64_DEPS]) {
			const at = spec.lastIndexOf("@");
			const name = spec.slice(0, at);
			expect(`${name}@${declared[name]}`).toBe(spec);
		}
	});
});

describe("buildRemoteHealthProbe", () => {
	it("passes the secret via env, never on the argv", () => {
		const probe = buildRemoteHealthProbe(48000);
		expect(probe).toContain('ODIN_HEALTH_SECRET="$ODIN_OLD_SECRET"');
		expect(probe).toContain("process.env.ODIN_HEALTH_SECRET");
		expect(probe).toContain("statusCode===200");
	});

	it("probes an authenticated route, not the public health check", () => {
		const probe = buildRemoteHealthProbe(48000);
		expect(probe).toContain("/trpc/settings.branchPrefix.get");
		expect(probe).not.toContain("health.check");
	});
});

describe("Odin's own Node on the server", () => {
	it("downloads the pinned Linux build once, by CPU, with curl or wget", () => {
		const command = buildNodeInstallCommand("/srv/odin");
		expect(command).toContain("cat '/srv/odin/node/.version'");
		expect(command).toContain(`node-v${REMOTE_NODE_VERSION}-linux-$a.tar.gz`);
		expect(command).toContain("x86_64) a=x64;;");
		expect(command).toContain("aarch64) a=arm64;;");
		expect(command).toContain("curl -fsSL");
		expect(command).toContain("wget -qO-");
		expect(command).toContain("Linux servers only");
	});

	it("adds the tokenizers arm64 binding only on an arm64 server", () => {
		const command = buildProvisionCommand(
			"/srv/odin/backend",
			["a@1"],
			"/srv/odin",
		);
		expect(command).toContain(
			"aarch64|arm64) arm64='@anush008/tokenizers-linux-arm64-gnu@0.6.0';;",
		);
		expect(command).toContain("'a@1' $arm64");
	});

	it("runs npm and the backend on that Node, not the server's", () => {
		const path = "export PATH='/srv/odin/node/bin':\"$PATH\";";
		expect(
			buildProvisionCommand("/srv/odin/backend", ["a@1"], "/srv/odin"),
		).toContain(path);
		const start = buildRemoteStartCommand(config, {
			existing: { pid: 1 },
			bundleHash: "h",
			organizationId: "remote",
			bundlePath: "/srv/odin/backend/host-service.js",
			migrationsDir: "/srv/odin/backend/host-migrations",
			hookPort: 1,
			hookVersion: "2",
			vitePort: 5173,
		});
		// Before the health probe's node -e and the daemon's node.
		expect(start.indexOf(path)).toBeLessThan(start.indexOf("node -e"));
	});
});
