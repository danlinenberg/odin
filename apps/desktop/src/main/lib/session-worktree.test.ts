import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createSessionWorktree,
	reviveSessionWorktree,
	worktreeName,
} from "./session-worktree";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function clone() {
	const dir = mkdtempSync(path.join(tmpdir(), "session-wt-"));
	git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
	git(dir, "clone", "-q", "origin.git", "repo");
	const repo = path.join(dir, "repo");
	writeFileSync(path.join(repo, "a"), "a\n");
	git(repo, "add", "a");
	git(
		repo,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-qm",
		"init",
	);
	git(repo, "push", "-q", "origin", "main");
	git(repo, "remote", "set-head", "origin", "-a");
	return repo;
}

test("a session worktree is a new branch off origin's default, under .worktrees/", async () => {
	const repo = clone();
	git(repo, "checkout", "-q", "-b", "elsewhere");
	const made = await createSessionWorktree(repo, "Fix the login bug!");
	if (!made) throw new Error("no worktree");
	expect(made.path).toBe(path.join(repo, ".worktrees", made.branch));
	expect(made.branch).toMatch(/^fix-the-login-bug-[a-z0-9]{4}$/);
	expect(git(made.path, "branch", "--show-current")).toBe(made.branch);
	expect(git(made.path, "rev-parse", "HEAD")).toBe(
		git(repo, "rev-parse", "origin/main"),
	);
	expect(git(repo, "status", "--porcelain")).toBe("");
	const exclude = readFileSync(path.join(repo, ".git/info/exclude"), "utf8");
	expect(exclude.match(/\/\.worktrees\//g)).toHaveLength(1);
	await createSessionWorktree(repo, "again");
	expect(
		readFileSync(path.join(repo, ".git/info/exclude"), "utf8").match(
			/\/\.worktrees\//g,
		),
	).toHaveLength(1);
});

test("a worktree or a plain folder gets no second one", async () => {
	const repo = clone();
	const made = await createSessionWorktree(repo, "first");
	expect(await createSessionWorktree(made?.path ?? "", "second")).toBeNull();
	expect(await createSessionWorktree(tmpdir(), "plain")).toBeNull();
});

test("a repo with no origin gets none - the pruner could never judge it", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "session-wt-"));
	git(dir, "init", "-q", "-b", "main");
	expect(await createSessionWorktree(dir, "local")).toBeNull();
});

test("a pruned session worktree comes back on its branch for a resume", async () => {
	const repo = clone();
	const made = await createSessionWorktree(repo, "resume me");
	if (!made) throw new Error("no worktree");
	rmSync(made.path, { recursive: true, force: true });
	await reviveSessionWorktree(made.path);
	expect(git(made.path, "branch", "--show-current")).toBe(made.branch);
	await reviveSessionWorktree(made.path);
});

test("a title with no letters still names a worktree", () => {
	expect(worktreeName("!!!")).toMatch(/^session-[a-z0-9]{4}$/);
});
