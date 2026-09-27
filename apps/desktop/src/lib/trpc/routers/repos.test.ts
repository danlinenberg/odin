import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createReposRouter,
	renderDiff,
	renderPullRequestDiff,
	scanRepos,
} from "./repos";

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
	// A worktree: .git is a file pointing back at the clone, not a directory.
	make("dev/odin/worktrees/feature");
	writeFileSync(join(home, "dev/odin/worktrees/feature/.git"), "gitdir: ...\n");
	// Pruned: TCC-protected folders are never descended into, or macOS prompts.
	make("Desktop/scratch/.git");
	make("Documents/notes/.git");
	make("Downloads/cloned-repo/.git");
	// Pruned: walking these asks for the Apple Music / Photos libraries.
	make("Music/Music/.git");
	make("Pictures/Photos Library.photoslibrary/.git");
	make("Movies/TV/.git");

	expect(await scanRepos(home)).toEqual([
		join(home, "dev/odin"),
		join(home, "dev/work/api"),
	]);
});

test("the default repo round-trips through the config file, and rejects a non-repo", async () => {
	const home = mkdtempSync(join(tmpdir(), "odin-default-repo-"));
	process.env.ODIN_CONFIG_PATH = join(home, "odin.json");
	delete process.env.DAN_DEFAULT_REPO;
	const repo = join(home, "dev/odin");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(home, "Documents"), { recursive: true });

	const caller = createReposRouter().createCaller({});

	expect(await caller.getDefault()).toBeNull();
	await caller.setDefault({ path: repo });
	expect(await caller.getDefault()).toBe(repo);

	expect(caller.setDefault({ path: join(home, "Documents") })).rejects.toThrow(
		/Not a git repo/,
	);
	// Still the one that was set — a rejected pick must not clear it.
	expect(await caller.getDefault()).toBe(repo);

	await caller.setDefault({ path: null });
	expect(await caller.getDefault()).toBeNull();
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

	// A session that started after that commit owns none of it — the panel says
	// so instead of passing a stranger's work off as this session's.
	const stale = await renderDiff(repo, 80, Date.now() + 1000);
	expect(stale.source).toBe("nothing from this session");
	expect(stale.ansi).toBe("");

	writeFileSync(join(repo, "a.txt"), "two\n");
	writeFileSync(join(repo, "b.txt"), "untracked\n");
	const dirty = await renderDiff(repo, 80);
	expect(dirty.source).toBe("uncommitted changes");
	expect(dirty.ansi).toContain("two");
	expect(dirty.ansi).toContain("1 untracked file(s), not shown: b.txt");
	// The file summary heads the diff.
	expect(dirty.ansi).toContain("1 file changed");
});

test("renderPullRequestDiff reads the PR through gh, and says when nobody can", async () => {
	const patch =
		"diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
	const url = "https://github.com/danlinenberg/odin/pull/7";
	const pr = await renderPullRequestDiff(url, 80, async (args) => {
		expect(args).toEqual(["pr", "diff", url, "--color=never"]);
		return { stdout: patch };
	});
	expect(pr.source).toBe("odin PR #7");
	expect(pr.ansi).toContain("new");
	expect(pr.ansi).toContain("x.ts");

	expect(
		renderPullRequestDiff(url, 80, async () => {
			throw new Error("404");
		}),
	).rejects.toThrow(/No logged-in gh account/);
});
