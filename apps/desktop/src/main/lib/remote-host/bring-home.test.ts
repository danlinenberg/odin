import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bringMirrorHome,
	claudeProjectDir,
	lastCwd,
	movedNote,
	packScript,
	parsePacked,
	removeWorktreeScript,
	unpackWork,
} from "./bring-home";

const sh = (cwd: string, cmd: string, env: Record<string, string> = {}) =>
	execFileSync("bash", ["-c", cmd], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
const git = (cwd: string, args: string) =>
	sh(cwd, `git -c user.name=t -c user.email=t@t ${args}`);

describe("lastCwd", () => {
	test("is the folder of the last turn that has one", () => {
		const lines = [
			{ cwd: "/home/u/repos/a" },
			{ cwd: "/home/u/repos/a/.worktrees/x" },
			{ type: "summary" },
		].map((line) => JSON.stringify(line));
		expect(lastCwd(`${lines.join("\n")}\n`)).toBe(
			"/home/u/repos/a/.worktrees/x",
		);
		expect(lastCwd("not json")).toBeNull();
	});
});

test("a host branch with commits and uncommitted work lands in a local worktree", async () => {
	const root = mkdtempSync(join(tmpdir(), "bring-home-"));
	const origin = join(root, "origin.git");
	sh(root, `git init -q --bare -b main ${origin}`);
	const seed = join(root, "seed");
	sh(root, `git clone -q ${origin} seed`);
	writeFileSync(join(seed, "a.txt"), "base\n");
	git(seed, "add a.txt");
	git(seed, "commit -q -m base");
	git(seed, "push -q origin main");

	// The host: a session worktree with a commit, an edit and a new file.
	const hostRepo = join(root, "host-repo");
	sh(root, `git clone -q ${origin} host-repo`);
	const top = join(hostRepo, ".worktrees", "odin-abc");
	git(hostRepo, `worktree add -q -b odin/abc ${top} origin/main`);
	writeFileSync(join(top, "b.txt"), "committed\n");
	git(top, "add b.txt");
	git(top, "commit -q -m work");
	writeFileSync(join(top, "a.txt"), "edited\n");
	sh(top, "mkdir -p sub && echo new > sub/c.txt");
	const bundlePath = join(root, "x.bundle");
	const out = sh(root, packScript(join(top, "sub"), bundlePath)).trim();
	const { bundlePath: path, ...packed } = parsePacked(out);
	expect(packed).toMatchObject({ branch: "odin/abc", sub: "sub" });
	expect(path).toBe(bundlePath);

	// This computer: its own clone, already holding a branch of that name.
	const local = join(root, "local");
	sh(root, `git clone -q ${origin} local`);
	git(local, "branch odin/abc");
	const { dir, branch } = await unpackWork(local, {
		...packed,
		branch: "odin/abc",
		bundle: readFileSync(bundlePath),
	});
	expect(branch).toBe("odin/abc-2");
	expect(dir).toBe(join(local, ".worktrees", "odin-abc"));
	expect(git(dir, "log -1 --format=%s").trim()).toBe("work");
	expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("edited\n");
	expect(existsSync(join(dir, "sub", "c.txt"))).toBe(true);
	expect(git(dir, "status --porcelain").split("\n").filter(Boolean)).toEqual([
		" M a.txt",
		"?? sub/",
	]);
	expect(movedNote(dir, null, branch)).toContain("on branch odin/abc-2");
});

test("a session on the shared checkout's default branch moves nothing and leaves it untouched", () => {
	const root = mkdtempSync(join(tmpdir(), "bring-home-main-"));
	const origin = join(root, "origin.git");
	sh(root, `git init -q --bare -b main ${origin}`);
	const seed = join(root, "seed");
	sh(root, `git clone -q ${origin} seed`);
	writeFileSync(join(seed, "a.txt"), "base\n");
	git(seed, "add a.txt");
	git(seed, "commit -q -m base");
	git(seed, "push -q origin main");

	// The host's main checkout, on main: another session's brief file lies in
	// it. A review task that never branched has nothing of its own to move.
	const hostRepo = join(root, "host-repo");
	sh(root, `git clone -q ${origin} host-repo`);
	sh(hostRepo, "mkdir -p .odin && echo brief > .odin/brief-other-task.md");
	const bundlePath = join(root, "x.bundle");
	const pack = () =>
		parsePacked(sh(root, packScript(hostRepo, bundlePath)).trim());
	const { bundlePath: path, ...packed } = pack();
	expect(packed).toMatchObject({ sub: "", origin, branch: "main", left: true });
	expect(path).toBeNull();
	expect(existsSync(bundlePath)).toBe(false);
	// No commit on the shared branch, and the stray file stays untracked.
	expect(git(hostRepo, "log -1 --format=%s").trim()).toBe("base");
	expect(git(hostRepo, "status --porcelain").trim()).toBe("?? .odin/");
	const note = movedNote("/Users/me/repo", { ...packed, bundle: null }, null);
	expect(note).toContain("Nothing moved from the host");
	expect(note).toContain("on its default branch main");

	// Clean, nothing left behind: the plain note.
	sh(hostRepo, "rm -r .odin");
	const clean = pack();
	expect(clean.left).toBe(false);
	expect(
		movedNote("/Users/me/repo", { ...clean, bundle: null }, null),
	).toContain("Paths from the host do not exist here");
});

test("outside a git checkout the script prints nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "bring-home-plain-"));
	expect(sh(dir, packScript(dir, join(dir, "x.bundle"))).trim()).toBe("");
});

/**
 * A host as a session left it: a clone under <root>/repos with the session's
 * worktree on its own branch, node_modules gitignored.
 */
function hostWorktree(pane: string) {
	const root = mkdtempSync(join(tmpdir(), "done-"));
	const origin = join(root, "origin.git");
	sh(root, `git init -q --bare -b main ${origin}`);
	const seed = join(root, "seed");
	sh(root, `git clone -q ${origin} seed 2>/dev/null`);
	writeFileSync(join(seed, "a.txt"), "base\n");
	writeFileSync(join(seed, ".gitignore"), "node_modules\n");
	git(seed, "add a.txt .gitignore");
	git(seed, "commit -q -m base");
	git(seed, "push -q origin main");
	const repo = join(root, "repos", "x");
	sh(root, `git clone -q ${origin} ${repo}`);
	const top = join(repo, ".worktrees", `odin-${pane.slice(0, 8)}`);
	git(repo, `worktree add -q -b odin/${pane.slice(0, 8)} ${top} origin/main`);
	return { root, repo, top };
}

describe("removeWorktreeScript", () => {
	test("Done removes the session's worktree, keeps its branch and saves its uncommitted files", () => {
		const { root, repo, top } = hostWorktree("abcdef1234");
		writeFileSync(join(top, "b.txt"), "committed\n");
		git(top, "add b.txt");
		git(top, "commit -q -m work");
		writeFileSync(join(top, "a.txt"), "edited\n");
		sh(
			top,
			"mkdir -p sub node_modules && echo new > sub/c.txt && echo x > node_modules/d.txt",
		);

		const out = sh(
			root,
			removeWorktreeScript("abcdef1234", join(root, "repos")),
			{ HOME: root },
		);
		expect(out.trim()).toBe(`removed ${top}`);
		expect(existsSync(top)).toBe(false);
		expect(git(repo, "worktree list --porcelain")).not.toContain(".worktrees");
		// The branch and its commits stay: a Resume gets the worktree back from it.
		expect(git(repo, "log -1 --format=%s odin/abcdef12").trim()).toBe("work");
		// What wasn't committed is one commit on the branch's head, under refs/pruned.
		const pruned = "refs/pruned/odin-abcdef12";
		expect(git(repo, `rev-parse ${pruned}^`)).toBe(
			git(repo, "rev-parse odin/abcdef12"),
		);
		expect(git(repo, `show ${pruned}:a.txt`)).toBe("edited\n");
		expect(git(repo, `show ${pruned}:sub/c.txt`)).toBe("new\n");
		expect(git(repo, `ls-tree -r --name-only ${pruned}`)).not.toContain(
			"node_modules",
		);
	});

	test("a clean worktree in ~/repos goes without a pruned ref, and a gone one is nothing to do", () => {
		const { root, repo, top } = hostWorktree("0123456789");
		// The task had no repo: the agent cloned under ~/repos, not the host's reposRoot.
		const script = removeWorktreeScript("0123456789", join(root, "elsewhere"));
		expect(sh(root, script, { HOME: root }).trim()).toBe(`removed ${top}`);
		expect(existsSync(top)).toBe(false);
		expect(git(repo, "for-each-ref refs/pruned").trim()).toBe("");
		expect(git(repo, "branch --list odin/01234567").trim()).toBe(
			"odin/01234567",
		);
		expect(sh(root, script, { HOME: root }).trim()).toBe("");
	});
});

describe("bringMirrorHome", () => {
	test("copies the transcript mirror to the folder it lands in", async () => {
		const projects = mkdtempSync(join(tmpdir(), "mirror-"));
		mkdirSync(join(projects, "-home-ubuntu-repos"));
		writeFileSync(join(projects, "-home-ubuntu-repos", "s1.jsonl"), "chat");
		const cwd = await bringMirrorHome(
			"s1",
			async () => "/Users/me/dev",
			projects,
		);
		expect(cwd).toBe("/Users/me/dev");
		const copy = join(projects, claudeProjectDir("/Users/me/dev"), "s1.jsonl");
		expect(readFileSync(copy, "utf8")).toBe("chat");
		expect(
			await bringMirrorHome("none", async () => "/x", projects),
		).toBeNull();
	});
});
