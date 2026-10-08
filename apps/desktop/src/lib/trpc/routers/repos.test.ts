import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createReposRouter,
	detectReposFolder,
	renderDiff,
	renderPullRequestDiff,
	scanRepos,
	splitPatch,
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

test("list adds the folders added as projects, which the scan can't see", async () => {
	const added = join(
		mkdtempSync(join(tmpdir(), "odin-added-")),
		"Documents/GitHub/app",
	);
	const caller = createReposRouter(async () => [added, added]).createCaller({});
	const listed = await caller.list();
	expect(listed.filter((path) => path === added)).toEqual([added]);
});

test("the default repo round-trips through the config file, takes a plain folder, and rejects a missing one", async () => {
	const home = mkdtempSync(join(tmpdir(), "odin-default-repo-"));
	process.env.ODIN_CONFIG_PATH = join(home, "odin.json");
	delete process.env.DAN_DEFAULT_REPO;
	const repo = join(home, "dev/odin");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(home, "Documents"), { recursive: true });

	const caller = createReposRouter(async () => []).createCaller({});

	// Unset: detected from the machine's real checkouts.
	const detected = detectReposFolder(await caller.list());
	expect(await caller.getDefault()).toBe(detected);
	await caller.setDefault({ path: repo });
	expect(await caller.getDefault()).toBe(repo);

	// Not a git repo, still fine.
	await caller.setDefault({ path: join(home, "Documents") });
	expect(await caller.getDefault()).toBe(join(home, "Documents"));
	await caller.setDefault({ path: repo });

	expect(caller.setDefault({ path: join(home, "nope") })).rejects.toThrow(
		/No such folder/,
	);
	// Still the one that was set - a rejected pick must not clear it.
	expect(await caller.getDefault()).toBe(repo);

	await caller.setDefault({ path: null });
	expect(await caller.getDefault()).toBe(detected);
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

	// Clean tree - the panel falls back to the commit that just landed.
	const clean = await renderDiff(repo);
	expect(clean.source).toBe("last commit");
	expect(clean.files.map((file) => file.path)).toEqual(["a.txt"]);

	// A session whose transcript never printed that commit's sha owns none of
	// it - the panel says so instead of passing a stranger's work off as its own.
	const sha = git("rev-parse", "HEAD").trim();
	const stale = await renderDiff(repo, "a.txt, read but not committed");
	expect(stale.source).toBe("nothing from this session");
	expect(stale.files).toEqual([]);
	const own = await renderDiff(repo, `[main ${sha.slice(0, 7)}] add a`);
	expect(own.source).toBe("last commit");

	writeFileSync(join(repo, "a.txt"), "two\n");
	writeFileSync(join(repo, "b.txt"), "untracked\n");
	const dirty = await renderDiff(repo);
	expect(dirty.source).toBe("uncommitted changes");
	expect(dirty.note).toBe("1 untracked file(s), not shown: b.txt");
	expect(dirty.files).toMatchObject([
		{ path: "a.txt", added: 1, removed: 1, binary: false },
	]);
	expect(dirty.files[0].patch).toContain("+two");

	// Another session's edits in the shared tree stay out of this one's diff.
	writeFileSync(join(repo, "c.txt"), "theirs\n");
	git("add", "c.txt");
	const mine = await renderDiff(repo, "edited a.txt");
	expect(mine.files.map((file) => file.path)).toEqual(["a.txt"]);
	expect(mine.note).toBe("1 file(s) changed by other sessions, not shown");
});

test("renderPullRequestDiff reads the PR through gh, and says when nobody can", async () => {
	const patch =
		"diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
	const url = "https://github.com/danlinenberg/odin/pull/7";
	const pr = await renderPullRequestDiff(url, async (args) => {
		expect(args).toEqual(["pr", "diff", url, "--color=never"]);
		return { stdout: patch };
	});
	expect(pr.source).toBe("odin PR #7");
	expect(pr.files).toMatchObject([{ path: "x.ts", patch }]);

	expect(
		renderPullRequestDiff(url, async () => {
			throw new Error("404");
		}),
	).rejects.toThrow(/No logged-in gh account/);
});

test("splitPatch cuts per file, drops a commit header, and counts +/-", () => {
	const chunks = splitPatch(
		[
			"commit abc",
			"    message",
			"diff --git a/one.ts b/one.ts",
			"--- a/one.ts",
			"+++ b/one.ts",
			"@@ -1 +1,2 @@",
			"-a",
			"+b",
			"+c",
			"diff --git a/old.ts b/new name.ts",
			"rename from old.ts",
			"diff --git a/icon.png b/icon.png",
			"Binary files a/icon.png and b/icon.png differ",
			"",
		].join("\n"),
	);
	expect(
		chunks.map(({ path, added, removed, binary }) => [
			path,
			added,
			removed,
			binary,
		]),
	).toEqual([
		["one.ts", 2, 1, false],
		["new name.ts", 0, 0, false],
		["icon.png", 0, 0, true],
	]);
});

test("detectReposFolder picks the home folder holding the most repos", () => {
	const home = "/Users/x";
	expect(
		detectReposFolder(
			[
				"/Users/x/dev/odin",
				"/Users/x/dev/work/api",
				"/Users/x/code/one",
				"/Users/x/dotfiles",
			],
			home,
		),
	).toBe("/Users/x/dev");
	expect(
		detectReposFolder(["/Users/x/dotfiles", "/opt/repo"], home),
	).toBeNull();
});
