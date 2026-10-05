import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(
	import.meta.dir,
	"../../../../../scripts/prune-worktrees.sh",
);
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A worktree with an edit and an untracked note, last touched `days` ago. */
function staleDirtyWorktree(days: number, editedNow = false) {
	const dir = mkdtempSync(path.join(tmpdir(), "prune-"));
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
	git(repo, "worktree", "add", "-q", "-b", "w", ".worktrees/w", "origin/main");
	const wt = path.join(repo, ".worktrees/w");
	writeFileSync(path.join(wt, "a"), "changed\n");
	writeFileSync(path.join(wt, "notes.md"), "my notes\n");
	const then = Date.now() / 1000 - days * 86400;
	const gitdir = git(wt, "rev-parse", "--absolute-git-dir");
	for (const file of [
		`${gitdir}/index`,
		`${gitdir}/HEAD`,
		`${wt}/a`,
		`${wt}/notes.md`,
	])
		utimesSync(file, then, then);
	if (editedNow) writeFileSync(path.join(wt, "notes.md"), "still writing\n");
	// The script ages a worktree by its reflog's own timestamp, too.
	const reflog = `${gitdir}/logs/HEAD`;
	const log = readFileSync(reflog, "utf8");
	writeFileSync(reflog, log.replace(/ \d{10} /g, ` ${Math.floor(then)} `));
	return repo;
}

const prune = (repo: string) =>
	execFileSync(SCRIPT, [repo], {
		encoding: "utf8",
		env: { ...process.env, PRUNE_MIN_AGE_HOURS: "0" },
	});

test("a dirty worktree left a week is removed, its files saved to a ref", () => {
	const repo = staleDirtyWorktree(10);
	expect(prune(repo)).toContain("remove w (files saved to refs/pruned/w)");
	expect(git(repo, "worktree", "list")).not.toContain(".worktrees/w");
	expect(git(repo, "show", "refs/pruned/w:a")).toBe("changed");
	expect(git(repo, "show", "refs/pruned/w:notes.md")).toBe("my notes");
});

test("a dirty worktree whose files were just edited stays", () => {
	const repo = staleDirtyWorktree(10, true);
	expect(prune(repo)).toContain("keep   w (uncommitted or untracked files)");
});
