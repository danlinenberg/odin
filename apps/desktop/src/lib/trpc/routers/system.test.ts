import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaude, markClaudeOnboarded } from "./system";

describe("findClaude", () => {
	test("skips a claude it can't run and takes the next one on PATH", () => {
		const root = mkdtempSync(join(tmpdir(), "find-claude-"));
		const [broken, empty, bundled] = ["broken", "empty", "bundled"].map(
			(name) => join(root, name),
		);
		for (const dir of [broken, empty, bundled]) mkdirSync(dir);
		writeFileSync(join(broken, "claude"), "");
		chmodSync(join(broken, "claude"), 0o644);
		writeFileSync(join(bundled, "claude"), "#!/bin/sh\n", { mode: 0o755 });

		expect(findClaude(`${broken}:${empty}:${bundled}`)).toBe(
			join(bundled, "claude"),
		);
		expect(findClaude(`${broken}:${empty}`)).toBeNull();
	});

	test("on Windows, splits PATH on ; and looks for claude.exe", () => {
		const root = mkdtempSync(join(tmpdir(), "find-claude-win-"));
		const [empty, local] = ["empty", "local"].map((name) => join(root, name));
		for (const dir of [empty, local]) mkdirSync(dir);
		writeFileSync(join(local, "claude.exe"), "", { mode: 0o755 });

		expect(findClaude(`${empty};${local}`, "win32")).toBe(
			join(local, "claude.exe"),
		);
		expect(findClaude(`${empty};${local}`, "darwin")).toBeNull();
	});
});

describe("markClaudeOnboarded", () => {
	test("adds the missing first-run answers and keeps everything else", async () => {
		const file = join(mkdtempSync(join(tmpdir(), "claude-json-")), "c.json");
		writeFileSync(
			file,
			JSON.stringify({ oauthAccount: { id: 1 }, theme: "light" }),
		);
		await markClaudeOnboarded(file);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			oauthAccount: { id: 1 },
			theme: "light",
			hasCompletedOnboarding: true,
		});
	});

	test("creates the file when missing, and leaves one it can't parse alone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "claude-json-"));
		await markClaudeOnboarded(join(dir, "new.json"));
		expect(JSON.parse(readFileSync(join(dir, "new.json"), "utf8"))).toEqual({
			theme: "dark",
			hasCompletedOnboarding: true,
		});
		writeFileSync(join(dir, "bad.json"), "{not json");
		await markClaudeOnboarded(join(dir, "bad.json"));
		expect(readFileSync(join(dir, "bad.json"), "utf8")).toBe("{not json");
	});
});
