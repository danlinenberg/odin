import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bringProblem,
	credentialsPayload,
	homeRelative,
	isBringableEnvName,
	LOCAL_ENV_FILE,
	LOCAL_ENV_SCRIPT,
	WRITE_CREDENTIALS_PY,
} from "./local-credentials";

describe("homeRelative", () => {
	test("~, $HOME and absolute paths inside home map to the same place there", () => {
		expect(homeRelative("~/.snowflake/key.p8", "/Users/me")).toBe(
			".snowflake/key.p8",
		);
		expect(homeRelative("$HOME/.config/x", "/Users/me")).toBe(".config/x");
		expect(homeRelative("/Users/me/keys/a b.pem", "/Users/me")).toBe(
			"keys/a b.pem",
		);
	});
	test("anything outside home, or home itself, is refused", () => {
		for (const path of [
			"/etc/passwd",
			"~/../other/x",
			"~",
			"relative/x",
			"",
			"/Users/meme/x",
		])
			expect(homeRelative(path, "/Users/me")).toBeNull();
	});
});

describe("env names", () => {
	test("plain names go; the session's own and Odin's do not", () => {
		expect(isBringableEnvName("SNOWFLAKE_ACCOUNT")).toBe(true);
		for (const name of ["PATH", "HOME", "ODIN_PORT", "ODIN_X", "1X", "A-B", ""])
			expect(isBringableEnvName(name)).toBe(false);
		expect(bringProblem("env", "PATH")).toContain("not an env var name");
		expect(bringProblem("file", "/etc/hosts")).toContain("not a file");
		expect(bringProblem("env", "SNOWFLAKE_USER")).toBeNull();
	});
});

describe("credentialsPayload", () => {
	test("only what is listed, and what is missing by name, never a value", async () => {
		const home = mkdtempSync(join(tmpdir(), "bring-home-"));
		mkdirSync(join(home, ".snowflake"));
		writeFileSync(join(home, ".snowflake", "key.p8"), "PRIVATE");
		writeFileSync(join(home, "unlisted"), "nope");
		const { payload, missing } = await credentialsPayload(
			["~/.snowflake/key.p8", "~/gone.pem"],
			["SNOWFLAKE_ACCOUNT", "NOT_SET"],
			{ SNOWFLAKE_ACCOUNT: "acme-123", OTHER: "secret" },
			home,
		);
		expect(payload.files).toEqual([
			{
				path: ".snowflake/key.p8",
				data: Buffer.from("PRIVATE").toString("base64"),
			},
		]);
		expect(payload.env).toEqual([["SNOWFLAKE_ACCOUNT", "acme-123"]]);
		expect(missing).toEqual(["~/gone.pem", "$NOT_SET"]);
		expect(JSON.stringify(missing)).not.toContain("acme-123");
	});
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.if(hasPython)("on the host (WRITE_CREDENTIALS_PY)", () => {
	const write = (home: string, payload: unknown) =>
		spawnSync("python3", ["-c", WRITE_CREDENTIALS_PY], {
			input: JSON.stringify(payload),
			env: { HOME: home, PATH: process.env.PATH },
		});

	test("files land under home, mode 0600, and the env file is read by a session", () => {
		const home = mkdtempSync(join(tmpdir(), "bring-host-"));
		const value = "it's a\nmulti-line $value";
		const out = write(home, {
			files: [
				{
					path: ".snowflake/key.p8",
					data: Buffer.from("PRIVATE").toString("base64"),
				},
			],
			env: [
				["SNOWFLAKE_ACCOUNT", "acme-123"],
				["TRICKY", value],
			],
		});
		expect(out.status).toBe(0);
		expect(out.stdout.toString()).toBe("");
		const key = join(home, ".snowflake", "key.p8");
		expect(readFileSync(key, "utf8")).toBe("PRIVATE");
		expect(statSync(key).mode & 0o777).toBe(0o600);
		expect(statSync(join(home, LOCAL_ENV_FILE)).mode & 0o777).toBe(0o600);
		const read = execFileSync(
			"/bin/bash",
			[
				"-c",
				`${LOCAL_ENV_SCRIPT}\nprintf '%s|%s' "$SNOWFLAKE_ACCOUNT" "$TRICKY"`,
			],
			{ env: { HOME: home, PATH: "/usr/bin:/bin" } },
		).toString();
		expect(read).toBe(`acme-123|${value}`);
	});

	test("an existing file is replaced at 0600; an emptied env list removes the env file", () => {
		const home = mkdtempSync(join(tmpdir(), "bring-host-"));
		writeFileSync(join(home, "k.pem"), "old", { mode: 0o644 });
		expect(
			write(home, {
				files: [{ path: "k.pem", data: Buffer.from("new").toString("base64") }],
				env: [["A", "1"]],
			}).status,
		).toBe(0);
		expect(readFileSync(join(home, "k.pem"), "utf8")).toBe("new");
		expect(statSync(join(home, "k.pem")).mode & 0o777).toBe(0o600);
		expect(write(home, { files: [], env: [] }).status).toBe(0);
		expect(existsSync(join(home, LOCAL_ENV_FILE))).toBe(false);
	});

	test("nothing is written outside home, through .. or a symlinked folder", () => {
		const home = mkdtempSync(join(tmpdir(), "bring-host-"));
		const outside = mkdtempSync(join(tmpdir(), "bring-outside-"));
		symlinkSync(outside, join(home, "link"));
		const data = Buffer.from("x").toString("base64");
		const climb = write(home, { files: [{ path: "../escape", data }] });
		expect(climb.status).not.toBe(0);
		expect(climb.stderr.toString()).not.toContain("eA==");
		expect(
			write(home, { files: [{ path: "link/escape", data }] }).status,
		).not.toBe(0);
		expect(existsSync(join(outside, "escape"))).toBe(false);
	});

	test("no env file: the session goes on", () => {
		const home = mkdtempSync(join(tmpdir(), "bring-host-"));
		expect(
			execFileSync("/bin/bash", ["-c", `${LOCAL_ENV_SCRIPT}\necho on`], {
				env: { HOME: home, PATH: "/usr/bin:/bin" },
			}).toString(),
		).toBe("on\n");
	});
});
