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
	unpackWork,
} from "./bring-home";

const sh = (cwd: string, cmd: string) =>
	execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
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

test("outside a git checkout the script prints nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "bring-home-plain-"));
	expect(sh(dir, packScript(dir, join(dir, "x.bundle"))).trim()).toBe("");
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
