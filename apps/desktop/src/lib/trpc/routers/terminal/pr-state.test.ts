import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type GhExec,
	pullRequestState,
	pullRequestWorktrees,
	worktreeHolding,
} from "./pr-state";

const URL = "https://github.com/imagenai/app-web-server/pull/6409";

const STATUS = `github.com
  ✓ Logged in to github.com account danlinenberg (keyring)
  - Active account: true
  ✓ Logged in to github.com account dan-linenberg-imagenai (keyring)
  - Active account: false
`;

describe("pullRequestState", () => {
	test("reads the state the active account can see", async () => {
		const exec: GhExec = async () => ({
			stdout: '{"state":"MERGED","statusCheckRollup":[]}',
		});
		expect(await pullRequestState(URL, exec)).toEqual({
			state: "MERGED",
			isDraft: false,
			pending: [],
			failed: [],
			passed: 0,
		});
	});

	test("splits the rollup into running, failed and green", async () => {
		const exec: GhExec = async () => ({
			stdout: JSON.stringify({
				state: "OPEN",
				isDraft: true,
				statusCheckRollup: [
					{ name: "pre-commit", status: "COMPLETED", conclusion: "SUCCESS" },
					{ name: "Cursor Bugbot", status: "IN_PROGRESS" },
					{ name: "pytest", status: "COMPLETED", conclusion: "FAILURE" },
					{ name: "[code]smith", status: "COMPLETED", conclusion: "SKIPPED" },
					// The older commit-status shape: no `status`, only `state`.
					{ context: "ci/circleci", state: "PENDING" },
				],
			}),
		});
		expect(await pullRequestState(URL, exec)).toEqual({
			state: "OPEN",
			isDraft: true,
			pending: ["Cursor Bugbot", "ci/circleci"],
			failed: ["pytest"],
			passed: 1,
		});
	});

	test("falls through the logged-in accounts until one can see the repo", async () => {
		const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
		const exec: GhExec = async (args, env) => {
			calls.push({ args, env });
			if (args[1] === "status") return { stdout: STATUS };
			if (args[1] === "token") return { stdout: `tok-${args[3]}\n` };
			// Only the work account can resolve this org's repo.
			if (env?.GH_TOKEN !== "tok-dan-linenberg-imagenai") {
				throw new Error("Could not resolve to a Repository");
			}
			return { stdout: '{"state":"CLOSED","statusCheckRollup":null}' };
		};
		expect((await pullRequestState(URL, exec))?.state).toBe("CLOSED");
		expect(calls.map((call) => call.args.slice(0, 4).join(" "))).toEqual([
			`pr view ${URL} --json`,
			"auth status",
			"auth token --user danlinenberg",
			`pr view ${URL} --json`,
			"auth token --user dan-linenberg-imagenai",
			`pr view ${URL} --json`,
		]);
	});

	test("no state rather than a throw when gh can't answer", async () => {
		const exec: GhExec = async () => {
			throw new Error("gh: command not found");
		};
		expect(await pullRequestState(URL, exec)).toBeNull();
	});
});

describe("worktreeHolding", () => {
	const porcelain = [
		"worktree /r\nHEAD aaa\nbranch refs/heads/main",
		"worktree /r/.worktrees/fix\nHEAD bbb\nbranch refs/heads/fix/thing",
		"worktree /r/.worktrees/det\nHEAD ccc\ndetached",
		"",
	].join("\n\n");

	test("finds the checkout with the branch, clone or worktree", () => {
		expect(worktreeHolding(porcelain, "fix/thing")).toBe("/r/.worktrees/fix");
		expect(worktreeHolding(porcelain, "main")).toBe("/r");
	});

	test("does not match a branch that merely shares a prefix", () => {
		expect(worktreeHolding(porcelain, "fix")).toBeNull();
	});
});

describe("pullRequestWorktrees", () => {
	test("lists each PR with the checkout holding its branch, newest first", async () => {
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "odin-prwt-")));
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
		git("init", "-q", "-b", "main");
		git(
			"-c",
			"user.email=a@b",
			"-c",
			"user.name=a",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"x",
		);
		git("worktree", "add", "-q", "-b", "fix/one", join(repo, ".worktrees/one"));
		const pr = (n: number) => `https://github.com/o/app/pull/${n}`;
		const branches: Record<string, string> = {
			[pr(1)]: "fix/one",
			[pr(2)]: "main",
			[pr(3)]: "gone", // its worktree was removed
		};
		const exec: GhExec = async (args) => ({ stdout: `${branches[args[2]]}\n` });
		const transcript = [
			pr(1),
			pr(3),
			pr(2),
			pr(1),
			"https://github.com/o/other/pull/9",
		].join(" ");

		expect(await pullRequestWorktrees(transcript, repo, "app", exec)).toEqual([
			{ url: pr(1), number: 1, worktree: join(repo, ".worktrees/one") },
			{ url: pr(2), number: 2, worktree: repo },
		]);
	});
});
