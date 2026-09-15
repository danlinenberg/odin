import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDiff, scanRepos } from "./repos";

test("scanRepos finds checkouts, skips pruned dirs and nested worktrees", async () => {
	const home = mkdtempSync(join(tmpdir(), "odin-repos-"));
	const make = (path: string) =>
		mkdirSync(join(home, path), { recursive: true });

	make("dev/odin/.git");
	make("dev/work/api/.git");
	// Pruned: a checkout vendored inside node_modules is not a repo you'd pick.
	make("dev/odin/node_modules/some-dep/.git");
	// Not a repo.
	make("Documents/notes");

	expect(await scanRepos(home)).toEqual([
		join(home, "dev/odin"),
		join(home, "dev/work/api"),
	]);
});

test("renderDiff shows uncommitted work, and the last commit when there is none", async () => {
	const repo = mkdtempSync(join(tmpdir(), "odin-diff-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git("add", "a.txt");
	git("commit", "-qm", "add a");

	// Clean tree — the panel falls back to the commit that just landed.
	const clean = await renderDiff(repo, 80);
	expect(clean.source).toBe("last commit");
	expect(clean.ansi).toContain("add a");

	writeFileSync(join(repo, "a.txt"), "two\n");
	writeFileSync(join(repo, "b.txt"), "untracked\n");
	const dirty = await renderDiff(repo, 80);
	expect(dirty.source).toBe("uncommitted changes");
	expect(dirty.ansi).toContain("two");
	expect(dirty.ansi).toContain("1 untracked file(s), not shown: b.txt");
});
