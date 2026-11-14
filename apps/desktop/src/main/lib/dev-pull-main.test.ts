import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullMainIfClean } from "./dev-pull-main";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pull-main-"));
	const origin = join(root, "origin.git");
	const clone = join(root, "clone");
	const commit = (message: string) =>
		git(
			clone,
			"-c",
			"user.email=a@example.com",
			"-c",
			"user.name=A",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			message,
		);
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["clone", "-q", origin, clone]);
	git(clone, "checkout", "-q", "-b", "main");
	commit("one");
	commit("two");
	git(clone, "push", "-q", "origin", "main");
	git(clone, "reset", "-q", "--hard", "HEAD~1");
	return { origin, clone };
}

describe("pullMainIfClean", () => {
	test("fast-forwards a clean main, leaves a dirty one alone", async () => {
		const { origin, clone } = setup();
		writeFileSync(join(clone, "dirty.txt"), "x");
		git(clone, "add", "dirty.txt");
		expect(await pullMainIfClean(clone)).toBe("skipped");
		git(clone, "reset", "-q");
		expect(await pullMainIfClean(clone)).toBe("pulled");
		expect(git(clone, "rev-parse", "HEAD")).toBe(
			git(origin, "rev-parse", "main"),
		);
		expect(await pullMainIfClean(clone)).toBe("current");
		git(clone, "checkout", "-q", "-b", "other");
		expect(await pullMainIfClean(clone)).toBe("skipped");
	});
});
