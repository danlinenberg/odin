import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkoutFilePath,
	createReposRouter,
	detectReposFolder,
	readWorkingFile,
	renderBranchDiff,
	renderDiff,
	renderPullRequestDiff,
	renderSinceDiff,
	scanRepos,
	snapshotTree,
	splitPatch,
	withLineEndingsOf,
	writeWorkingFile,
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
	// The walk is slow on a cold CI runner: it passed 5s there once.
}, 20_000);

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
	// A new file git doesn't track yet shows in full, after the edits.
	expect(dirty.note).toBe("");
	expect(dirty.files).toMatchObject([
		{ path: "a.txt", added: 1, removed: 1, binary: false },
		{ path: "b.txt", added: 1, removed: 0, binary: false },
	]);
	expect(dirty.files[0].patch).toContain("+two");
	expect(dirty.files[1].patch).toContain("new file mode");
	expect(dirty.files[1].patch).toContain("+untracked");

	// Another session's edits in the shared tree stay out of this one's diff.
	writeFileSync(join(repo, "c.txt"), "theirs\n");
	git("add", "c.txt");
	const mine = await renderDiff(repo, "edited a.txt");
	expect(mine.files.map((file) => file.path)).toEqual(["a.txt"]);
	expect(mine.note).toBe("1 file(s) changed by other sessions, not shown");

	// Whole file: lines far from the change come along as context.
	writeFileSync(
		join(repo, "a.txt"),
		`${Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")}\n`,
	);
	git("commit", "-qam", "long a");
	writeFileSync(
		join(repo, "a.txt"),
		`${Array.from({ length: 20 }, (_, i) => (i === 19 ? "last" : `line ${i}`)).join("\n")}\n`,
	);
	expect((await renderDiff(repo)).files[0].patch).not.toContain(" line 0");
	expect((await renderDiff(repo, undefined, true)).files[0].patch).toContain(
		" line 0",
	);
});

test("renderBranchDiff shows a branch's commits and edits since main, with no PR", async () => {
	const repo = mkdtempSync(join(tmpdir(), "odin-branch-diff-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	writeFileSync(join(repo, "base.txt"), "base\n");
	git("add", "base.txt");
	git("commit", "-qm", "base");

	// On main itself there is no base to compare with.
	expect((await renderBranchDiff(repo)).files).toEqual([]);

	git("checkout", "-qb", "feature");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git("add", "a.txt");
	git("commit", "-qm", "a");
	writeFileSync(join(repo, "b.txt"), "two\n");
	git("add", "b.txt");
	git("commit", "-qm", "b");
	// main moves on after the branch left it: not part of the branch's diff.
	git("checkout", "-q", "main");
	writeFileSync(join(repo, "later.txt"), "later\n");
	git("add", "later.txt");
	git("commit", "-qm", "later");
	git("checkout", "-q", "feature");
	// An edit not committed yet rides along, and so does a new file.
	writeFileSync(join(repo, "a.txt"), "one\nmore\n");
	writeFileSync(join(repo, "new.txt"), "fresh\n");

	const diff = await renderBranchDiff(repo);
	expect(diff.source).toBe("feature vs main · 2 commits");
	expect(diff.files.map((file) => file.path)).toEqual([
		"a.txt",
		"b.txt",
		"new.txt",
	]);
	expect(diff.files[0].patch).toContain("+more");
	expect(diff.files[2].patch).toContain("+fresh");
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

test("renderSinceDiff shows only what changed after the snapshot, and the snapshot touches nothing", async () => {
	const repo = mkdtempSync(join(tmpdir(), "odin-since-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git("add", "a.txt");
	git("commit", "-qm", "add a");
	writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
	writeFileSync(join(repo, "new.txt"), "fresh\n");

	const status = git("status", "--porcelain");
	const since = await snapshotTree(repo);
	expect(git("status", "--porcelain")).toBe(status);

	expect((await renderSinceDiff(repo, since)).files).toEqual([]);

	writeFileSync(join(repo, "a.txt"), "one\nTWO\n");
	const fixed = await renderSinceDiff(repo, since);
	expect(fixed.source).toBe("since review");
	expect(fixed.files.map((file) => file.path)).toEqual(["a.txt"]);
	expect(fixed.files[0].patch).toContain("-two");
	expect(fixed.files[0].patch).toContain("+TWO");
	expect(fixed.files[0].patch).not.toContain("+one");

	writeFileSync(join(repo, "b.txt"), "other session\n");
	const owned = await renderSinceDiff(repo, since, "edited a.txt");
	expect(owned.files.map((file) => file.path)).toEqual(["a.txt"]);
	expect(owned.note).toContain("1 file(s) changed by other sessions");
});

test("the Diff tab's Edit reads and saves a working file, and refuses a stale save", async () => {
	const repo = mkdtempSync(join(tmpdir(), "odin-edit-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "app.ts"), "const a = 1;\n");
	// Paths are the repo's, whatever subdirectory the session sits in.
	const read = await readWorkingFile(join(repo, "src"), "src/app.ts");
	expect(read.content).toBe("const a = 1;\n");
	const saved = await writeWorkingFile(
		repo,
		"src/app.ts",
		"const a = 2;\n",
		read.mtimeMs,
	);
	expect((await readWorkingFile(repo, "src/app.ts")).content).toBe(
		"const a = 2;\n",
	);
	// Written again after it was read (the agent, say): the old read can't save.
	await Bun.sleep(20);
	writeFileSync(join(repo, "src", "app.ts"), "const a = 3;\n");
	await expect(
		writeWorkingFile(repo, "src/app.ts", "mine", saved.mtimeMs),
	).rejects.toThrow("changed on disk");
	expect((await readWorkingFile(repo, "src/app.ts")).content).toBe(
		"const a = 3;\n",
	);
});

test("Edit stays inside the checkout and out of .git", async () => {
	const repo = mkdtempSync(join(tmpdir(), "odin-edit-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	await expect(checkoutFilePath(repo, "../outside.txt")).rejects.toThrow(
		"not a file in this checkout",
	);
	await expect(checkoutFilePath(repo, ".git/config")).rejects.toThrow(
		"not a file in this checkout",
	);
	await expect(readWorkingFile(repo, "gone.ts")).rejects.toThrow(
		"deleted files can't be edited",
	);
});

test("Save keeps a CRLF file's line endings", async () => {
	const repo = mkdtempSync(join(tmpdir(), "odin-edit-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(repo, "win.txt"), "one\r\ntwo\r\n");
	const read = await readWorkingFile(repo, "win.txt");
	await writeWorkingFile(repo, "win.txt", "one\ntwo\nthree\n", read.mtimeMs);
	expect(readFileSync(join(repo, "win.txt"), "utf8")).toBe(
		"one\r\ntwo\r\nthree\r\n",
	);
	expect(withLineEndingsOf("a\nb\n", "a\nc\n")).toBe("a\nc\n");
	expect(withLineEndingsOf("", "a\n")).toBe("a\n");
	// Mostly LF with a stray CRLF stays LF.
	expect(withLineEndingsOf("a\nb\nc\r\n", "x\ny\n")).toBe("x\ny\n");
});

test("a symlink in the checkout can't send a read or save outside it", async () => {
	const repo = mkdtempSync(join(tmpdir(), "odin-edit-"));
	const outside = mkdtempSync(join(tmpdir(), "odin-outside-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(outside, "secret.txt"), "keep\n");
	symlinkSync(join(outside, "secret.txt"), join(repo, "link.txt"));
	symlinkSync(outside, join(repo, "dir"));
	await expect(checkoutFilePath(repo, "link.txt")).rejects.toThrow(
		"not a file in this checkout",
	);
	await expect(checkoutFilePath(repo, "dir/secret.txt")).rejects.toThrow(
		"not a file in this checkout",
	);
	await expect(
		writeWorkingFile(repo, "link.txt", "changed", 0),
	).rejects.toThrow("not a file in this checkout");
	expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("keep\n");
	// A link that stays inside the checkout is fine.
	writeFileSync(join(repo, "real.txt"), "x\n");
	symlinkSync(join(repo, "real.txt"), join(repo, "alias.txt"));
	expect((await readWorkingFile(repo, "alias.txt")).content).toBe("x\n");
});
