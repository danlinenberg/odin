import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Client, Server, utils } from "ssh2";
import {
	type ClaudeSetupPart,
	claudeMdImports,
	claudeSyncStatus,
	partPaths,
	requestClaudeSync,
	streamToHost,
} from "./claude-sync";

/**
 * An SSH server in this process whose exec reads its stdin to the end and then
 * exits, saying nothing on stdout - like `tar -xzf -` on the host: 0, or 2
 * with a line on stderr for the command `fail`. And a client signed in to it.
 */
async function sshHost() {
	const key = utils.generateKeyPairSync("ed25519");
	const received: number[] = [];
	const server = new Server({ hostKeys: [key.private] }, (connection) => {
		connection.on("authentication", (context) => context.accept());
		connection.on("ready", () => {
			connection.on("session", (acceptSession) => {
				acceptSession().on("exec", (accept, _reject, info) => {
					const channel = accept();
					let bytes = 0;
					channel.on("data", (chunk: Buffer) => {
						bytes += chunk.length;
					});
					channel.on("end", () => {
						received.push(bytes);
						if (info.command === "fail") {
							channel.stderr.write("tar: no such file\n");
							channel.exit(2);
						} else channel.exit(0);
						channel.end();
					});
				});
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const client = new Client();
	await new Promise<void>((resolve, reject) =>
		client
			.once("ready", resolve)
			.once("error", reject)
			.connect({ host: "127.0.0.1", port, username: "me", password: "x" }),
	);
	return {
		client,
		received,
		close: () => {
			client.end();
			server.close();
		},
	};
}

describe("streamToHost", () => {
	test("settles with the bytes sent once a command that prints nothing exits", async () => {
		const host = await sshHost();
		try {
			const bytes = await streamToHost(
				host.client,
				"unpack",
				Readable.from([Buffer.alloc(70_000, 1), Buffer.alloc(30_000, 2)]),
			);
			expect(bytes).toBe(100_000);
			expect(host.received).toEqual([100_000]);
		} finally {
			host.close();
		}
	});

	test("fails with the command's stderr when it exits non-zero", async () => {
		const host = await sshHost();
		try {
			await expect(
				streamToHost(host.client, "fail", Readable.from([Buffer.from("x")])),
			).rejects.toThrow("tar: no such file");
		} finally {
			host.close();
		}
	});
});

describe("Claude setup sync", () => {
	test("CLAUDE.md's @imports inside ~/.claude come along; nothing outside it", () => {
		expect(
			claudeMdImports(
				"# Me\n@imagen.md\n@~/.claude/rules/x.md\n@/etc/passwd\n@../secret.md\n@~/notes.md\ntext @inline.md",
			),
		).toEqual(["imagen.md", "rules/x.md"]);
	});

	test("each part names only paths that exist, never the login or accounts", () => {
		const root = mkdtempSync(join(tmpdir(), "claude-sync-"));
		writeFileSync(join(root, "CLAUDE.md"), "@imagen.md\n");
		writeFileSync(join(root, "imagen.md"), "x");
		writeFileSync(join(root, ".credentials.json"), "{}");
		mkdirSync(join(root, "skills"));
		expect(partPaths("instructions", root)).toEqual(["CLAUDE.md", "imagen.md"]);
		expect(partPaths("skills", root)).toEqual(["skills"]);
		expect(partPaths("commands", root)).toEqual([]);
		const every = (
			["instructions", "skills", "commands", "plugins", "settings"] as const
		).flatMap((part) => partPaths(part, root));
		expect(every).not.toContain(".credentials.json");
	});
});

describe("a sync runs in the main process, one at a time", () => {
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

	test("the status shows the copy under way; parts asked for meanwhile go out as one copy after it, the latest set", async () => {
		const runs: (readonly ClaudeSetupPart[])[] = [];
		const finish: (() => void)[] = [];
		const copy = (parts: readonly ClaudeSetupPart[]) => {
			runs.push(parts);
			return new Promise<void>((resolve) => finish.push(resolve));
		};
		const done = requestClaudeSync(["skills"], copy);
		expect(claudeSyncStatus()).toEqual({
			parts: ["skills"],
			next: null,
			error: null,
		});
		expect(requestClaudeSync(["skills", "plugins"], copy)).toBe(done);
		requestClaudeSync(["plugins"], copy);
		expect(claudeSyncStatus().next).toEqual(["plugins"]);
		expect(runs).toEqual([["skills"]]);
		finish[0]?.();
		await settle();
		expect(runs).toEqual([["skills"], ["plugins"]]);
		expect(claudeSyncStatus()).toEqual({
			parts: ["plugins"],
			next: null,
			error: null,
		});
		finish[1]?.();
		await done;
		expect(claudeSyncStatus()).toEqual({
			parts: null,
			next: null,
			error: null,
		});
	});

	test("a copy that fails is reported until the next one starts, never thrown", async () => {
		await requestClaudeSync(["skills"], async () => {
			throw new Error("host unreachable");
		});
		expect(claudeSyncStatus()).toEqual({
			parts: null,
			next: null,
			error: "host unreachable",
		});
		const done = requestClaudeSync(["skills"], async () => {});
		expect(claudeSyncStatus().error).toBeNull();
		await done;
		expect(claudeSyncStatus()).toEqual({
			parts: null,
			next: null,
			error: null,
		});
	});
});
