import { expect, test } from "bun:test";
import {
	entryPort,
	hostAlias,
	remoteFolderUri,
	withHostEntry,
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
