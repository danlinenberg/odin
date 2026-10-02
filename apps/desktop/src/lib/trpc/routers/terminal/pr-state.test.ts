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
			stdout:
				'{"state":"MERGED","reviewDecision":"APPROVED","statusCheckRollup":[]}',
		});
		expect(await pullRequestState(URL, exec)).toEqual({
			state: "MERGED",
			isDraft: false,
			approved: true,
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
			approved: false,
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
	test("finds every PR's checkout, across sibling repos, newest first", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "odin-prwt-")));
		const repo = (name: string) => {
			const dir = join(root, name);
			const git = (...args: string[]) =>
				execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
			execFileSync("git", ["init", "-q", "-b", "main", dir]);
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
			return git;
		};
		repo("app")(
			"worktree",
			"add",
			"-q",
			"-b",
			"fix/one",
			join(root, "app/.worktrees/one"),
		);
		repo("other")("checkout", "-q", "-b", "feat/two");
		const pr = (name: string, n: number) =>
			`https://github.com/o/${name}/pull/${n}`;
		const branches: Record<string, string> = {
			[pr("app", 1)]: "fix/one",
			[pr("app", 2)]: "main",
			[pr("app", 3)]: "gone", // its worktree was removed
			[pr("other", 9)]: "feat/two", // a sibling repo, checked out in its clone
			[pr("nowhere", 4)]: "x", // a repo not cloned here
		};
		const exec: GhExec = async (args) => ({ stdout: `${branches[args[2]]}\n` });
		const transcript = [
			pr("app", 1),
			pr("app", 3),
			pr("nowhere", 4),
			pr("other", 9),
			pr("app", 2),
			pr("app", 1),
		].join(" ");

		// Called from inside a worktree: the clone and its siblings still resolve.
		expect(
			await pullRequestWorktrees(
				transcript,
				join(root, "app/.worktrees/one"),
				exec,
			),
		).toEqual([
			{
				url: pr("app", 1),
				number: 1,
				repo: "app",
				worktree: join(root, "app/.worktrees/one"),
				isMain: false,
			},
			{
				url: pr("app", 2),
				number: 2,
				repo: "app",
				worktree: join(root, "app"),
				isMain: true,
			},
			{
				url: pr("other", 9),
				number: 9,
				repo: "other",
				worktree: join(root, "other"),
				isMain: true,
			},
		]);
	});
});
