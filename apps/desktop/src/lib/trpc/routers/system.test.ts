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
});
