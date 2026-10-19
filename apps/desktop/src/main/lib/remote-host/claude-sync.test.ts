import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMdImports, partPaths } from "./claude-sync";

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
