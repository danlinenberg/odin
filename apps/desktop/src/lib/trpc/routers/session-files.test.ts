import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionFiles } from "./session-files";

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "odin-session-files-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	mkdirSync(join(dir, "src"));
	mkdirSync(join(dir, "node_modules"));
	writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
	writeFileSync(join(dir, "src", "app.ts"), "");
	writeFileSync(join(dir, "README.md"), "");
	writeFileSync(join(dir, "node_modules", "dep.js"), "");
	execFileSync("git", ["add", "."], { cwd: dir });
	writeFileSync(join(dir, "new file.md"), "");
	return dir;
}

describe("listSessionFiles", () => {
	test("tracked and new files, not ignored ones", async () => {
		const files = await listSessionFiles(repo());
		expect(files.sort()).toEqual([
			".gitignore",
			"README.md",
			"new file.md",
			"src/app.ts",
		]);
	});

	test("stops at the cap", async () => {
		expect(await listSessionFiles(repo(), 2)).toHaveLength(2);
	});

	test("a folder that isn't a checkout has no files", async () => {
		expect(
			await listSessionFiles(mkdtempSync(join(tmpdir(), "odin-plain-"))),
		).toEqual([]);
		expect(await listSessionFiles("/no/such/folder")).toEqual([]);
	});
});
