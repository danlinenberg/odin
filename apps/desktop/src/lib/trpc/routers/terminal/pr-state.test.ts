import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	firstParagraph,
	type GhExec,
	mergedPullRequests,
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
			awaiting: [],
			failed: [],
			passed: 0,
			author: null,
			mine: null,
			title: null,
			summary: null,
		});
	});

	test("carries the title and the description's opening paragraph", async () => {
		const exec: GhExec = async () => ({
			stdout: JSON.stringify({
				state: "OPEN",
				title: "Brief: list only your PRs",
				body: "## Summary\n\nThe brief listed **every** PR as `its own`.\n\n- detail",
			}),
		});
		const status = await pullRequestState(URL, exec);
		expect(status?.title).toBe("Brief: list only your PRs");
		expect(status?.summary).toBe("The brief listed every PR as its own.");
	});

	test("clips a long opening paragraph, and an empty body has none", () => {
		expect(firstParagraph("x".repeat(400))).toBe(`${"x".repeat(280)}…`);
		expect(firstParagraph("")).toBeNull();
		expect(firstParagraph("## Only a heading")).toBeNull();
	});

	test("mine when a logged-in account opened it, not when a teammate did", async () => {
		const by =
			(login: string): GhExec =>
			async (args) => ({
				stdout:
					args[1] === "status"
						? STATUS
						: JSON.stringify({ state: "OPEN", author: { login } }),
			});
		expect((await pullRequestState(URL, by("danlinenberg")))?.mine).toBe(true);
		expect((await pullRequestState(URL, by("assafd-svg")))?.mine).toBe(false);
	});

	test("mine is unknown, not false, when gh can't list the accounts", async () => {
		const exec: GhExec = async (args) => {
			if (args[1] === "status") throw new Error("gh auth status failed");
			return {
				stdout: JSON.stringify({ state: "OPEN", author: { login: "x" } }),
			};
		};
		const status = await pullRequestState(URL, exec);
		expect(status?.author).toBe("x");
		expect(status?.mine).toBeNull();
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
			awaiting: [],
			failed: ["pytest"],
			passed: 1,
			author: null,
			mine: null,
			title: null,
			summary: null,
		});
	});

	test("a Terrateam apply waiting for its comment is awaiting, not running", async () => {
		const exec: GhExec = async () => ({
			stdout: JSON.stringify({
				state: "OPEN",
				statusCheckRollup: [
					{
						context: "terrateam plan: workspaces/prod/s3 default",
						state: "SUCCESS",
					},
					{ context: "terrateam apply", state: "PENDING" },
					{
						context: "terrateam apply: workspaces/prod/s3 default",
						state: "PENDING",
					},
				],
			}),
		});
		const status = await pullRequestState(URL, exec);
		expect(status?.pending).toEqual([]);
		expect(status?.awaiting).toEqual([
			"terrateam apply",
			"terrateam apply: workspaces/prod/s3 default",
		]);
		expect(status?.passed).toBe(1);
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

describe("mergedPullRequests", () => {
	const merged = (login: string) => ({
		merged: true,
		mergedAt: "2026-10-04T10:00:00Z",
		author: { login },
	});

	test("one call per repo; only your merged PRs, with when they merged", async () => {
		const calls: string[] = [];
		const exec: GhExec = async (args) => {
			if (args[0] === "auth") return { stdout: STATUS };
			const query = args.at(-1) as string;
			calls.push(query);
			return {
				stdout: JSON.stringify({
					data: {
						repository: query.includes('"odin"')
							? {
									p1: merged("danlinenberg"),
									p2: { merged: false, mergedAt: null },
									p3: merged("teammate"),
								}
							: { p7: merged("dan-linenberg-imagenai") },
					},
				}),
			};
		};
		const urls = [
			"https://github.com/me/odin/pull/1",
			"https://github.com/me/odin/pull/2",
			"https://github.com/me/odin/pull/3",
			"https://github.com/me/web/pull/7",
		];
		const at = Date.parse("2026-10-04T10:00:00Z");
		const expected = new Map([
			[urls[0], at],
			[urls[3], at],
		]);
		expect(await mergedPullRequests(urls, exec)).toEqual(expected);
		expect(calls).toHaveLength(2);
		// Merged is final and the unmerged one was just asked: no new calls.
		expect(await mergedPullRequests(urls, exec)).toEqual(expected);
		expect(calls).toHaveLength(2);
	});

	test("a repo no account can read counts as unmerged", async () => {
		const exec: GhExec = async () => {
			throw new Error("Could not resolve to a Repository");
		};
		expect(
			await mergedPullRequests(["https://github.com/me/secret/pull/3"], exec),
		).toEqual(new Map());
	});
});
