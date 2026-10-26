import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushWork, SENT_WIP_MESSAGE } from "./send-to-host";

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

test("a session worktree's branch and uncommitted work go to origin; the shared checkout's stay", async () => {
	const root = mkdtempSync(join(tmpdir(), "send-to-host-"));
	const origin = join(root, "origin.git");
	sh(root, `git init -q --bare -b main ${origin}`);
	sh(root, `git clone -q ${origin} repo`);
	const repo = join(root, "repo");
	writeFileSync(join(repo, "a.txt"), "base\n");
	sh(repo, "git add a.txt && git commit -q -m base && git push -q origin main");
	sh(repo, "git remote set-head origin main");

	const tree = join(repo, ".worktrees", "x");
	sh(repo, `git worktree add -q -b feat ${tree}`);
	writeFileSync(join(tree, "b.txt"), "new\n");
	expect(await pushWork(tree)).toEqual({
		branch: "feat",
		committed: true,
		left: false,
	});
	expect(sh(root, `git -C ${origin} log -1 --format=%s feat`)).toBe(
		SENT_WIP_MESSAGE,
	);
	expect(sh(tree, "git status --porcelain")).toBe("");

	writeFileSync(join(repo, "a.txt"), "edited\n");
	expect(await pushWork(repo)).toEqual({
		branch: null,
		committed: false,
		left: true,
	});
	sh(repo, "git checkout -q -b shared");
	expect(await pushWork(repo)).toEqual({
		branch: "shared",
		committed: false,
		left: true,
	});
	expect(sh(repo, "git status --porcelain -- a.txt")).toBe("M a.txt");
});
