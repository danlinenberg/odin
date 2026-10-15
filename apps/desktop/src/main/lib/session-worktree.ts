import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
	createWorktree,
	fetchDefaultBranch,
	getDefaultBranch,
	hasOriginRemote,
} from "lib/trpc/routers/workspaces/utils/git";

const run = promisify(execFile);

export interface SessionWorktree {
	path: string;
	branch: string;
}

// The suffix: two sessions with one title don't collide.
export function worktreeName(title: string): string {
	const slug =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40)
			.replace(/-+$/, "") || "session";
	return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

const isMainCheckout = (repo: string) =>
	statSync(path.join(repo, ".git"), { throwIfNoEntry: false })?.isDirectory() ??
	false;

// info/exclude, not .gitignore: keeps it out of `git status` without a commit in the user's repo.
async function excludeWorktrees(repo: string): Promise<void> {
	const exclude = path.join(repo, ".git", "info", "exclude");
	const current = await readFile(exclude, "utf8").catch(() => "");
	if (current.split("\n").some((line) => line.trim() === "/.worktrees/"))
		return;
	await mkdir(path.dirname(exclude), { recursive: true });
	await appendFile(
		exclude,
		`${current && !current.endsWith("\n") ? "\n" : ""}/.worktrees/\n`,
	);
}

// A launch waits this long for the fetch; a hung network must not hold the session.
const FETCH_WAIT_MS = 10_000;

// Null when `repo` isn't a main checkout with an origin: the pruner can only judge work against origin.
export async function createSessionWorktree(
	repo: string,
	title: string,
): Promise<SessionWorktree | null> {
	if (!isMainCheckout(repo) || !(await hasOriginRemote(repo))) return null;
	const base = await getDefaultBranch(repo);
	// Offline or slow: the last fetched one is still a better base than a stale local branch.
	await Promise.race([
		fetchDefaultBranch(repo, base).catch(() => {}),
		new Promise((done) => setTimeout(done, FETCH_WAIT_MS)),
	]);
	const branch = worktreeName(title);
	const dir = path.join(repo, ".worktrees", branch);
	await excludeWorktrees(repo);
	await createWorktree(repo, branch, dir, `origin/${base}`);
	return { path: dir, branch };
}

// The pruner keeps the branch, and `claude --resume` only finds a conversation from its own directory.
export async function reviveSessionWorktree(dir: string): Promise<void> {
	if (existsSync(dir)) return;
	const match = /^(.+)\/\.worktrees\/([^/]+)$/.exec(dir);
	if (!match) return;
	const [, repo = "", branch = ""] = match;
	if (!isMainCheckout(repo)) return;
	await run("git", ["-C", repo, "worktree", "prune"]);
	await run("git", ["-C", repo, "worktree", "add", dir, branch]);
}
