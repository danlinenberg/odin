import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HostExec,
	hostCheckouts,
	hostGit,
	hostSnapshot,
} from "./host-git";

/** This computer's bash standing in for the host's shell. */
const bashExec: HostExec = (command, input = "") =>
	new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", command]);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
		child.stdin.end(input);
	});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A clone with one commit and a worktree of it, as a host session leaves them. */
function cloneWithWorktree() {
	const tree = realpathSync(mkdtempSync(join(tmpdir(), "host-git-")));
	const clone = join(tree, "app");
	mkdirSync(clone);
	git(clone, "init", "-q", "-b", "main");
	git(clone, "config", "user.email", "a@example.com");
	git(clone, "config", "user.name", "Alex");
	writeFileSync(join(clone, "a.txt"), "one\n");
	git(clone, "add", "a.txt");
	git(clone, "commit", "-q", "-m", "first");
	const worktree = join(clone, ".worktrees", "fix");
	git(clone, "worktree", "add", "-q", "-b", "fix", worktree);
	return { clone, worktree };
}

describe("host git", () => {
	test("hostCheckouts maps the host's folders to checkouts and owning clones", async () => {
		const { clone, worktree } = cloneWithWorktree();
		mkdirSync(join(worktree, "src"));
		const checkouts = await hostCheckouts(bashExec, [
			join(worktree, "src"),
			clone,
			"/",
		]);
		expect(checkouts.rootOf(join(worktree, "src"))).toBe(worktree);
		expect(checkouts.rootOf(clone)).toBe(clone);
		expect(checkouts.rootOf("/")).toBeNull();
		expect(checkouts.ownerOf(worktree)).toBe(clone);
		expect(checkouts.ownerOf(clone)).toBe(clone);
	});

	test("hostGit runs in the worktree, not the clone, and keeps stdout on exit 1", async () => {
		const { clone, worktree } = cloneWithWorktree();
		writeFileSync(join(clone, "a.txt"), "clone edit\n");
		writeFileSync(join(worktree, "a.txt"), "worktree edit\n");
		writeFileSync(join(worktree, "new.txt"), "new\n");
		const run = hostGit(bashExec, worktree);
		const patch = await run(["--no-pager", "diff", "--no-color", "HEAD"]);
		expect(patch).toContain("+worktree edit");
		expect(patch).not.toContain("clone edit");
		const added = await run([
			"--no-pager",
			"diff",
			"--no-index",
			"--no-color",
			"--",
			"/dev/null",
			"new.txt",
		]).catch((error: { stdout?: string }) => error.stdout ?? "");
		expect(added).toContain("+new");
		await expect(run(["rev-parse", "no-such-ref"])).rejects.toThrow();
	});

	test("hostSnapshot writes the checkout as a tree and leaves the index alone", async () => {
		const { worktree } = cloneWithWorktree();
		writeFileSync(join(worktree, "new.txt"), "new\n");
		const tree = await hostSnapshot(bashExec, worktree);
		expect(tree).toMatch(/^[0-9a-f]{40}$/);
		expect(git(worktree, "ls-tree", "--name-only", tree)).toContain("new.txt");
		expect(git(worktree, "status", "--porcelain")).toBe("?? new.txt");
	});
});
