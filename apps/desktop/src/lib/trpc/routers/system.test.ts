import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaude } from "./system";

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
