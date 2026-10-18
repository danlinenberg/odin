import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseVerdicts, prunedRef } from "./prune-worktrees";

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

test("a worktree outside .worktrees/ goes by its path, and a locked one stays", () => {
	const repo = staleDirtyWorktree(10);
	const outside = path.join(repo, "..", "sibling");
	git(repo, "worktree", "add", "-q", "-b", "s", outside, "origin/main");
	const locked = path.join(repo, "..", "locked");
	git(repo, "worktree", "add", "-q", "-b", "l", locked, "origin/main");
	git(repo, "worktree", "lock", locked);
	const out = execFileSync(SCRIPT, ["--dry-run", repo], {
		encoding: "utf8",
		env: {
			...process.env,
			PRUNE_MIN_AGE_HOURS: "0",
			PRUNE_LANDED_MIN_AGE_HOURS: "0",
		},
	});
	const real = (p: string) => git(p, "rev-parse", "--show-toplevel");
	expect(out).toContain(`remove ${real(outside)} (dry run)`);
	expect(out).toContain(`keep   ${real(locked)} (locked)`);
	expect(out).toContain("remove w (dry run, files saved to refs/pruned/w)");
});

test("a pruned path's files go to a valid ref, one per path", () => {
	const ref = prunedRef("/Users/me/.superset/worktrees/x");
	expect(ref).toBe("refs/pruned/Users/me/_.superset/worktrees/x");
	expect(prunedRef("w")).toBe("refs/pruned/w");
	expect(prunedRef("/Users/me/a-b/c")).not.toBe(prunedRef("/Users/me/a/b-c"));
	const bash = execFileSync(
		"bash",
		[
			"-c",
			`eval "$(sed -n '/^pruned_ref()/,/^}/p' "$0")"; pruned_ref "$1"`,
			SCRIPT,
			"/Users/me/.superset/worktrees/x",
		],
		{ encoding: "utf8" },
	).trim();
	expect(bash).toBe(ref);
	execFileSync("git", ["check-ref-format", ref]);
});

test("parseVerdicts reads a name that is a path with spaces or parens", () => {
	expect(parseVerdicts("keep   /Users/me/My Repos/wt (locked)")).toEqual([
		{ name: "/Users/me/My Repos/wt", safe: false, reason: "locked" },
	]);
	expect(parseVerdicts("keep   /Users/me/repo (copy)/wt (locked)")).toEqual([
		{ name: "/Users/me/repo (copy)/wt", safe: false, reason: "locked" },
	]);
});

test("parseVerdicts reads the script's remove and keep lines", () => {
	expect(
		parseVerdicts(
			[
				"remove landed (dry run)",
				"remove old-dirty (dry run, files saved to refs/pruned/old-dirty)",
				"keep   unique (has changes not on origin/main)",
				"From github.com:x/y",
				"",
			].join("\n"),
		),
	).toEqual([
		{ name: "landed", safe: true, reason: "Landed on main" },
		{
			name: "old-dirty",
			safe: true,
			reason:
				"Landed - its uncommitted files are saved to refs/pruned/old-dirty first",
		},
		{
			name: "unique",
			safe: false,
			reason: "has changes not on origin/main",
		},
	]);
});
