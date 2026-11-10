import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	entryPort,
	hostAlias,
	machineSettingsScript,
	remoteFolderUri,
	withHostEntry,
	withHostSettings,
} from "./vscode-bridge";

const entry = {
	port: 51234,
	user: "odin-meirav",
	keyPath: "/Users/m/.odin/vscode/id_ed25519",
	knownHosts: "/Users/m/.odin/vscode/known_hosts",
	hostKeyAlias: "odin-i-0abc",
};

test("the host entry goes first, then replaces itself in place", () => {
	const mine = "Host *\n  User someone-else\n";
	const first = withHostEntry(mine, "odin-prod", entry);
	expect(first.startsWith("# Odin: odin-prod - begin\nHost odin-prod\n")).toBe(
		true,
	);
	expect(first.endsWith(mine)).toBe(true);
	expect(entryPort(first, "odin-prod")).toBe(51234);

	const again = withHostEntry(first, "odin-prod", { ...entry, port: 60000 });
	expect(again.match(/Host odin-prod/g)).toHaveLength(1);
	expect(entryPort(again, "odin-prod")).toBe(60000);
	expect(again.endsWith(mine)).toBe(true);

	expect(withHostEntry(again, "odin-prod", { ...entry, port: 60000 })).toBe(
		again,
	);
	expect(entryPort(mine, "odin-prod")).toBeNull();
});

test("an empty config gets just the entry", () => {
	const config = withHostEntry("", "odin-prod", entry);
	expect(config).toContain("  HostName 127.0.0.1\n  Port 51234\n");
	expect(config).toContain("  StrictHostKeyChecking accept-new\n");
	expect(config.endsWith("# Odin: odin-prod - end\n")).toBe(true);
});

test("host names and folders become ssh and VS Code addresses", () => {
	expect(hostAlias("prod box/1")).toBe("odin-prod-box-1");
	expect(hostAlias("odin-prod")).toBe("odin-prod");
	expect(remoteFolderUri("odin-prod", "/home/odin-m/repos/my repo")).toBe(
		"vscode-remote://ssh-remote+odin-prod/home/odin-m/repos/my%20repo",
	);
});

test("VS Code is told the host is Linux and gets this computer's extensions, once", () => {
	const set = withHostSettings('{"editor.fontSize": 13}', "odin-prod", [
		"ms-python.python",
		"ms-vscode-remote.remote-ssh",
	]);
	expect(JSON.parse(set ?? "")).toEqual({
		"editor.fontSize": 13,
		"remote.SSH.remotePlatform": { "odin-prod": "linux" },
		"remote.SSH.defaultExtensions": ["ms-python.python"],
	});
	expect(
		withHostSettings(set ?? "", "odin-prod", ["ms-python.python"]),
	).toBeNull();
	const more = JSON.parse(
		withHostSettings(set ?? "", "odin-dev", ["dbaeumer.vscode-eslint"]) ?? "",
	);
	expect(more["remote.SSH.remotePlatform"]).toEqual({
		"odin-prod": "linux",
		"odin-dev": "linux",
	});
	expect(more["remote.SSH.defaultExtensions"]).toEqual([
		"ms-python.python",
		"dbaeumer.vscode-eslint",
	]);
	expect(withHostSettings("", "odin-prod")).toContain('"odin-prod": "linux"');
	expect(withHostSettings('{\n  // mine\n  "a": 1\n}', "odin-prod")).toBeNull();
});

test("the host's VS Code terminal runs zsh on the copied startup files", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-vscode-"));
	const settings = join(home, ".vscode-server/data/Machine/settings.json");
	mkdirSync(dirname(settings), { recursive: true });
	writeFileSync(settings, '{"terminal.integrated.env.linux": {"A": "1"}}');
	const script = machineSettingsScript("/home/odin-dan/.odin/mac-shell");
	execFileSync("bash", ["-c", script], {
		env: { PATH: process.env.PATH, HOME: home },
	});
	expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
		"terminal.integrated.defaultProfile.linux": "zsh",
		"terminal.integrated.env.linux": {
			A: "1",
			ZDOTDIR: "/home/odin-dan/.odin/mac-shell",
		},
	});
});
