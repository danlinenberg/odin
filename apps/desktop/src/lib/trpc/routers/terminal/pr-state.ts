import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execWithShellEnv } from "../workspaces/utils/shell-env";

/**
 * Odin fork: has this PR shipped, and is its CI done? The brief lists the PRs a
 * session opened, and the next two questions are always which of them got
 * merged and whether the bots have finished arguing about the rest.
 */

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED";

export interface PullRequestStatus {
	state: PullRequestState;
	/** Open but not ready for review — the brief says "draft", not "open". */
	isDraft: boolean;
	/** GitHub's review decision is APPROVED: all that's left is the merge click. */
	approved: boolean;
	/** Checks still running, by name — "Cursor Bugbot" is the one you're waiting on. */
	pending: string[];
	/**
	 * Checks that only move when a person acts, by name. A Terrateam apply sits at
	 * PENDING from the moment its plan lands until someone comments `terrateam
	 * apply`, so counting it as running reads as stuck CI.
	 */
	awaiting: string[];
	/** Checks that failed, by name. */
	failed: string[];
	/** Checks that came back green. Skipped ones aren't counted either way. */
	passed: number;
}

/** Injectable so the retry below is testable without a GitHub account. */
export type GhExec = (
	args: string[],
	env?: Record<string, string>,
) => Promise<{ stdout: string }>;

const gh: GhExec = (args, env) => execWithShellEnv("gh", args, { env });

/** `✓ Logged in to github.com account NAME (keyring)` — one per account. */
const ACCOUNT = /Logged in to \S+ account (\S+)/g;

/**
 * One rollup entry. GitHub mixes two shapes here: Actions jobs (`CheckRun`,
 * still running until `status` is COMPLETED) and the older commit statuses
 * (`StatusContext`, which only ever has a `state`). Bots land as either.
 */
interface RollupEntry {
	name?: string;
	context?: string;
	status?: string;
	conclusion?: string;
	state?: string;
}

const MANUAL_GATE = /^terrateam apply\b/;

const FAILED = new Set([
	"FAILURE",
	"ERROR",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
]);

function status(stdout: string): PullRequestStatus | null {
	const pr = JSON.parse(stdout) as {
		state?: string;
		isDraft?: boolean;
		reviewDecision?: string | null;
		statusCheckRollup?: RollupEntry[] | null;
	};
	if (pr.state !== "OPEN" && pr.state !== "MERGED" && pr.state !== "CLOSED") {
		return null;
	}
	const out: PullRequestStatus = {
		state: pr.state,
		isDraft: pr.isDraft === true,
		approved: pr.reviewDecision === "APPROVED",
		pending: [],
		awaiting: [],
		failed: [],
		passed: 0,
	};
	for (const entry of pr.statusCheckRollup ?? []) {
		const name = entry.name ?? entry.context ?? "check";
		// A CheckRun carries `status`; a StatusContext only `state`. Anything not
		// finished is still in flight — that's the bit worth showing live.
		const done = entry.status ? entry.status === "COMPLETED" : true;
		const result = entry.conclusion ?? entry.state ?? "";
		if (result === "PENDING" && MANUAL_GATE.test(name)) {
			out.awaiting.push(name);
		} else if (!done || result === "PENDING" || result === "EXPECTED") {
			out.pending.push(name);
		} else if (FAILED.has(result)) {
			out.failed.push(name);
		} else if (result === "SUCCESS") {
			out.passed += 1;
		}
		// SKIPPED / NEUTRAL: didn't run, didn't fail. Counting them as green
		// inflates "12 checks passed" on repos that skip half their matrix.
	}
	return out;
}

/**
 * `gh` talks to github.com as its *active* account, so a repo only a second
 * logged-in account can see 404s — a work org while the personal account is
 * active, or the reverse. The owner in the url doesn't name the account that
 * can read it (`imagenai/...` is read by `dan-linenberg-imagenai`), so on a
 * miss just try each logged-in account's token in turn. Null when none of them
 * can (no gh, no access, deleted repo).
 */
export async function ghAsAnyAccount<T>(
	args: string[],
	parse: (stdout: string) => T,
	exec: GhExec = gh,
): Promise<T | null> {
	try {
		return parse((await exec(args)).stdout);
	} catch {
		// Fall through to the other accounts.
	}
	let authStatus: string;
	try {
		authStatus = (await exec(["auth", "status"])).stdout;
	} catch {
		return null;
	}
	for (const [, account] of authStatus.matchAll(ACCOUNT)) {
		try {
			const { stdout: token } = await exec([
				"auth",
				"token",
				"--user",
				account,
			]);
			return parse((await exec(args, { GH_TOKEN: token.trim() })).stdout);
		} catch {
			// Not this account's repo either.
		}
	}
	return null;
}

/** Null when no logged-in account can see the PR; the panel shows no label. */
export function pullRequestState(
	url: string,
	exec: GhExec = gh,
): Promise<PullRequestStatus | null> {
	return ghAsAnyAccount(
		[
			"pr",
			"view",
			url,
			"--json",
			"state,isDraft,reviewDecision,statusCheckRollup",
		],
		status,
		exec,
	);
}

/** The checkout in `git worktree list --porcelain` that has `branch` checked out. */
export function worktreeHolding(
	porcelain: string,
	branch: string,
): string | null {
	for (const block of porcelain.split("\n\n")) {
		const lines = block.split("\n");
		if (lines.includes(`branch refs/heads/${branch}`)) {
			return lines[0]?.replace(/^worktree /, "") || null;
		}
	}
	return null;
}

/** One of a session's PRs, and the checkout that has its branch. */
export interface PullRequestCheckout {
	url: string;
	number: number;
	/** The GitHub repo name, from the url. */
	repo: string;
	worktree: string;
	/** The clone itself rather than one of its `git worktree add`s. */
	isMain: boolean;
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/g;

/** `git worktree list --porcelain` for the repo holding `dir`; "" outside one. */
async function worktreeList(dir: string): Promise<string> {
	try {
		return (
			await execWithShellEnv("git", [
				"-C",
				dir,
				"worktree",
				"list",
				"--porcelain",
			])
		).stdout;
	} catch {
		return "";
	}
}

/** git lists the main checkout first, always. */
const mainCheckout = (porcelain: string) =>
	/^worktree (.+)$/m.exec(porcelain)?.[1] ?? null;

/**
 * Where a session's PRs live on disk: for each PR it linked, the checkout that
 * has the PR's branch. The transcript's cwds can't say — Claude Code resets
 * its shell to the launch dir after every command and agents reach worktrees
 * with `git -C` — but a PR names its branch exactly. A PR in another repo is
 * found through that repo's clone: a sibling of `checkout`'s clone (~/dev/imagen/*
 * sit together), else a path the transcript mentions. Newest first; a PR with
 * no checkout (worktree removed, repo not cloned) drops out.
 *
 * ponytail: 8 newest PRs, one gh call each. Batch through GraphQL if sessions
 * start opening more than that.
 */
export async function pullRequestWorktrees(
	transcript: string,
	checkout: string,
	exec: GhExec = gh,
): Promise<PullRequestCheckout[]> {
	const seen = new Map<string, { repo: string; number: number }>();
	for (const match of [...transcript.matchAll(PR_URL)].reverse()) {
		if (!seen.has(match[0])) {
			seen.set(match[0], { repo: match[1], number: Number(match[2]) });
		}
	}
	const urls = [...seen].slice(0, 8);
	if (!urls.length) return [];

	const lists = new Map<string, Promise<string>>();
	const listOf = (dir: string) => {
		if (!lists.has(dir)) lists.set(dir, worktreeList(dir));
		return lists.get(dir) as Promise<string>;
	};
	const home = mainCheckout(await listOf(checkout)) ?? checkout;
	const cloneOf = (repo: string): string | null => {
		if (basename(home) === repo) return home;
		const mentioned = [
			...transcript.matchAll(
				new RegExp(
					`(/[\\w./-]*?/${repo.replace(/[.]/g, "\\.")})(?=[/"'\\s\\\\]|$)`,
					"g",
				),
			),
		].map((match) => match[1]);
		return (
			[join(dirname(home), repo), ...mentioned].find((dir) =>
				existsSync(join(dir, ".git")),
			) ?? null
		);
	};

	const found = await Promise.all(
		urls.map(async ([url, { repo, number }]) => {
			const clone = cloneOf(repo);
			if (!clone) return null;
			const branch = await ghAsAnyAccount(
				["pr", "view", url, "--json", "headRefName", "-q", ".headRefName"],
				(stdout) => stdout.trim(),
				exec,
			);
			if (!branch) return null;
			const list = await listOf(clone);
			const worktree = worktreeHolding(list, branch);
			return worktree
				? {
						url,
						number,
						repo,
						worktree,
						isMain: worktree === mainCheckout(list),
					}
				: null;
		}),
	);
	return found.filter((pr): pr is PullRequestCheckout => pr !== null);
}
