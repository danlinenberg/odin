import { statSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
	createWorktree,
	fetchDefaultBranch,
	getDefaultBranch,
	hasOriginRemote,
} from "lib/trpc/routers/workspaces/utils/git";

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

// Null when `repo` isn't a main checkout: a worktree already is one, a plain folder has nothing to branch.
export async function createSessionWorktree(
	repo: string,
	title: string,
): Promise<SessionWorktree | null> {
	if (!isMainCheckout(repo)) return null;
	const base = await getDefaultBranch(repo);
	let startPoint = base;
	if (await hasOriginRemote(repo)) {
		// Offline: the last fetched one is still a better base than a stale local branch.
		await fetchDefaultBranch(repo, base).catch(() => {});
		startPoint = `origin/${base}`;
	}
	const branch = worktreeName(title);
	const dir = path.join(repo, ".worktrees", branch);
	await excludeWorktrees(repo);
	await createWorktree(repo, branch, dir, startPoint);
	return { path: dir, branch };
}
