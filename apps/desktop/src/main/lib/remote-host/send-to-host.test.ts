import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	dropSnapshot,
	pushWork,
	SENT_WIP_MESSAGE,
	sentNote,
	snapshotRef,
} from "./send-to-host";

const sh = (cwd: string, cmd: string) =>
	execFileSync("bash", ["-c", cmd], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	}).trim();

function repoWithOrigin() {
	const root = mkdtempSync(join(tmpdir(), "send-to-host-"));
	const origin = join(root, "origin.git");
	sh(root, `git init -q --bare -b main ${origin}`);
	sh(root, `git clone -q ${origin} repo 2>/dev/null`);
	const repo = join(root, "repo");
	writeFileSync(join(repo, "a.txt"), "base\n");
	sh(repo, "git add a.txt && git commit -q -m base && git push -q origin main");
	sh(repo, "git remote set-head origin main");
	return { root, origin, repo };
}

const SESSION = "abcdef1234";

test("a session worktree's branch and uncommitted work go to origin as its own branch", async () => {
	const { root, origin, repo } = repoWithOrigin();
	const tree = join(repo, ".worktrees", "x");
	sh(repo, `git worktree add -q -b feat ${tree}`);
	writeFileSync(join(tree, "b.txt"), "new\n");
	expect(await pushWork(tree, SESSION)).toEqual({
		branch: "feat",
		committed: true,
		left: false,
		snapshot: null,
	});
	expect(sh(root, `git -C ${origin} log -1 --format=%s feat`)).toBe(
		SENT_WIP_MESSAGE,
	);
	expect(sh(tree, "git status --porcelain")).toBe("");
});

test("a shared checkout on main sends a copy of its uncommitted work and local commits, and stays as it was", async () => {
	const { root, origin, repo } = repoWithOrigin();
	// A local commit no remote has, an edit, a new file and an ignored one.
	writeFileSync(join(repo, "c.txt"), "local commit\n");
	sh(repo, "git add c.txt && git commit -q -m local");
	writeFileSync(join(repo, "a.txt"), "edited\n");
	writeFileSync(join(repo, ".gitignore"), "secret.env\n");
	writeFileSync(join(repo, "secret.env"), "TOKEN=x\n");
	writeFileSync(join(repo, "notes.md"), "draft\n");
	const before = sh(repo, "git status --porcelain");

	const work = await pushWork(repo, SESSION);
	expect(work).toEqual({
		branch: null,
		committed: true,
		left: false,
		snapshot: snapshotRef(SESSION),
	});
	// The checkout here is untouched: same HEAD, same changes, nothing staged.
	expect(sh(repo, "git log -1 --format=%s")).toBe("local");
	expect(sh(repo, "git status --porcelain")).toBe(before);
	expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("edited\n");

	// The host: its placeholder branch, then what the note says to run.
	const host = join(root, "host");
	sh(root, `git clone -q ${origin} host`);
	sh(host, "git checkout -q -b odin/abcdef12");
	const note = sentNote(work, repo, "odin/abcdef12");
	const command = note.match(/First run (.+?) in the folder/)?.[1] ?? "false";
	sh(host, command);
	expect(sh(host, "git branch --show-current")).toBe("odin/abcdef12");
	expect(sh(host, "git log -1 --format=%s")).toBe("local");
	expect(readFileSync(join(host, "a.txt"), "utf8")).toBe("edited\n");
	expect(readFileSync(join(host, "notes.md"), "utf8")).toBe("draft\n");
	expect(
		sh(host, "git status --porcelain")
			.split("\n")
			.map((l) => l.trim())
			.sort(),
	).toEqual(["?? .gitignore", "?? notes.md", "M a.txt"]);
	expect(sh(host, "ls")).not.toContain("secret.env");
	// The host deleted the copy from origin, and it was never a branch.
	expect(sh(root, `git -C ${origin} for-each-ref refs/odin`)).toBe("");
	expect(
		sh(root, `git -C ${origin} branch --list '--format=%(refname:short)'`),
	).toBe("main");
	// The note says plainly that other sessions' edits came along.
	expect(note).toContain("theirs included");

	// Moving again replaces the copy; a failed move deletes it.
	writeFileSync(join(repo, "a.txt"), "edited again\n");
	await pushWork(repo, SESSION);
	expect(sh(root, `git -C ${origin} show ${snapshotRef(SESSION)}:a.txt`)).toBe(
		"edited again",
	);
	await dropSnapshot(repo, SESSION);
	expect(sh(root, `git -C ${origin} for-each-ref refs/odin`)).toBe("");
	// Nothing left to delete is no error.
	await dropSnapshot(repo, SESSION);
});

test("a shared checkout on its own branch pushes it, and copies the uncommitted part", async () => {
	const { root, origin, repo } = repoWithOrigin();
	sh(repo, "git checkout -q -b shared");
	writeFileSync(join(repo, "a.txt"), "edited\n");
	const work = await pushWork(repo, SESSION);
	expect(work).toEqual({
		branch: "shared",
		committed: true,
		left: false,
		snapshot: snapshotRef(SESSION),
	});
	expect(sh(repo, "git status --porcelain -- a.txt")).toBe("M a.txt");
	expect(sh(root, `git -C ${origin} log -1 --format=%s shared`)).toBe("base");
	const note = sentNote(work, repo, "odin/abcdef12");
	expect(note).toContain(
		`git fetch origin ${snapshotRef(SESSION)} && git checkout -B shared FETCH_HEAD`,
	);
});

test("a clean checkout on main sends nothing", async () => {
	const { repo } = repoWithOrigin();
	expect(await pushWork(repo, SESSION)).toEqual({
		branch: null,
		committed: false,
		left: false,
		snapshot: null,
	});
});
