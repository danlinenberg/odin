import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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

/**
 * Claude asks "Is this a project you trust?" in a folder it hasn't seen, and a
 * new worktree is one. The task Odin hands it lands on that dialog, whose
 * default is "No, exit": Claude quit before saving a conversation, and the card
 * had nothing to resume. The user picked the repo, so mark it trusted. Claude
 * looks up a worktree by its own path or by its main checkout's, depending on
 * the repo, so pass both. Leaves a config it can't parse alone.
 */
export async function trustForClaude(
	dirs: string[],
	file = path.join(homedir(), ".claude.json"),
): Promise<void> {
	let config: { projects?: Record<string, Record<string, unknown>> } = {};
	try {
		config = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
	}
	const projects = config.projects ?? {};
	if (dirs.every((dir) => projects[dir]?.hasTrustDialogAccepted === true))
		return;
	for (const dir of dirs)
		projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };
	await writeFile(file, JSON.stringify({ ...config, projects }, null, 2));
}

// Null outside a git repo.
export async function mainCheckoutOf(dir: string): Promise<string | null> {
	const { stdout } = await run("git", [
		"-C",
		dir,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]).catch(() => ({ stdout: "" }));
	return stdout.trim() ? path.dirname(stdout.trim()) : null;
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
