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

	test("Odin's own .odin/ files stay out, tracked or not", async () => {
		const dir = repo();
		mkdirSync(join(dir, ".odin"));
		writeFileSync(join(dir, ".odin", "task-1.md"), "");
		execFileSync("git", ["add", ".odin"], { cwd: dir });
		writeFileSync(join(dir, ".odin", "task-2.md"), "");
		mkdirSync(join(dir, "src", ".odin"));
		writeFileSync(join(dir, "src", ".odin", "task-3.md"), "");
		writeFileSync(join(dir, "src", "odin.md"), "");
		const files = await listSessionFiles(dir);
		expect(files.filter((f) => f.includes(".odin/"))).toEqual([]);
		expect(files).toContain("src/odin.md");
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
