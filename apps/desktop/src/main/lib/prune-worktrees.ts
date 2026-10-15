import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import {
	readOdinConfig,
	resolveGithubToken,
} from "lib/trpc/routers/odin-config";
import { projectRepos, scanRepos } from "lib/trpc/routers/repos";

/**
 * Remove session worktrees whose PR already merged or closed - each one is a
 * full install, and sessions leave them in every repo they work in: 79 dead
 * ones across a dozen repos filled the disk. The rules live in
 * scripts/prune-worktrees.sh, which is also runnable by hand with --dry-run.
 *
 * Every repo on the machine with a linked worktree gets a pass. The script comes
 * from the Odin checkout (`odinRepo` in odin.json, or the one a dev run runs
 * from), so an install with no checkout prunes nothing on its own. GitHub's token comes from Settings → Connections: it
 * lets the script tell a merged PR from unmerged work when main has since
 * changed the same files; repos it can't see fall back to gh's own logins.
 */
// Settings → Advanced turns this off; read every pass, so no restart needed.
const EVERY_MS = 10 * 60 * 1000;
const FIRST_RUN_MS = 5 * 60 * 1000;

const run = promisify(execFile);

// ponytail: scanned once per launch, like the session picker - a repo cloned
// since then gets its pass after a restart.
let repos: Promise<string[]> | null = null;

const SCRIPT = "scripts/prune-worktrees.sh";

/** The checkout's script - what the 10-minute pruner runs. */
function pruneScript(): string | null {
	const odinRepo =
		process.env.ODIN_REPO_DIR ??
		readOdinConfig().odinRepo ??
		// A dev run is a checkout: apps/desktop is two levels down.
		(app.isPackaged ? undefined : path.join(app.getAppPath(), "../.."));
	const script = odinRepo && path.join(odinRepo, SCRIPT);
	return script && existsSync(script) ? script : null;
}

/**
 * Settings → Storage runs only when you open it or press Delete, so an install
 * with no checkout uses the copy shipped in the app.
 */
function storageScript(): string | null {
	const shipped = path.join(process.resourcesPath, "resources", SCRIPT);
	return pruneScript() ?? (existsSync(shipped) ? shipped : null);
}

// The scan skips ~/Documents, so a ~/Documents/GitHub clone is only known as a project.
async function reposWithWorktrees(): Promise<string[]> {
	repos ??= scanRepos();
	const all = new Set([...(await repos), ...(await projectRepos())]);
	return [...all].filter((repo) =>
		existsSync(path.join(repo, ".git", "worktrees")),
	);
}

export const worktreePath = (repo: string, name: string) =>
	path.isAbsolute(name) ? name : path.join(repo, ".worktrees", name);

export const prunedRef = (name: string) =>
	`refs/pruned/${name
		.replace(/^\/+/, "")
		.replace(/[^A-Za-z0-9._/-]/g, "-")
		.replace(/(^|\/)\./g, "$1_.")}`;

function runScript(script: string, args: string[]) {
	const token = resolveGithubToken();
	// Through bash: a copied resource can lose its exec bit.
	return run("bash", [script, ...args], {
		env: {
			...process.env,
			// Merged means gone at the next pass, not an hour later.
			PRUNE_LANDED_MIN_AGE_HOURS: "0",
			...(token ? { GH_TOKEN: token } : {}),
		},
		timeout: 5 * 60 * 1000,
	});
}

async function prune(): Promise<void> {
	const script = pruneScript();
	if (!script) return;
	if (readOdinConfig().pruneMergedWorktrees === false) return;
	// One repo at a time: each pass fetches and asks GitHub about every branch.
	for (const repo of await reposWithWorktrees()) {
		try {
			const { stdout } = await runScript(script, [repo]);
			const removed = stdout.split("\n").filter((l) => l.startsWith("remove"));
			if (removed.length)
				console.warn(`[main] prune-worktrees ${repo}:\n${removed.join("\n")}`);
		} catch (error) {
			const { stderr, message } = error as { stderr?: string; message: string };
			console.warn(`[main] prune-worktrees ${repo} failed:`, stderr || message);
		}
	}
}

export function startWorktreePruner(): void {
	setTimeout(() => {
		void prune();
		setInterval(() => void prune(), EVERY_MS).unref();
	}, FIRST_RUN_MS).unref();
}

export interface Verdict {
	name: string;
	/** The script would remove it: its work is on main and nothing is lost. */
	safe: boolean;
	reason: string;
}

/** The script's `remove <name> (...)` / `keep <name> (why)` lines. */
export function parseVerdicts(stdout: string): Verdict[] {
	return stdout.split("\n").flatMap((line): Verdict[] => {
		// The reason never holds a paren, so a "(" in a path stays in the name.
		const match = /^(remove|keep)\s+(.+?)(?: \(([^()]*)\))?$/.exec(line.trim());
		if (!match) return [];
		const [, verb, name = "", why = ""] = match;
		if (verb === "keep") return [{ name, safe: false, reason: why }];
		const saved = /files saved to (\S+)/.exec(why)?.[1];
		return [
			{
				name,
				safe: true,
				reason: saved
					? `Landed - its uncommitted files are saved to ${saved} first`
					: "Landed on main",
			},
		];
	});
}

export interface WorktreeInfo extends Verdict {
	repo: string;
	path: string;
	prunedRef: string;
	sizeBytes: number | null;
	/** ms; the worktree's index - a commit, checkout or staging touches it. */
	touchedAt: number | null;
}

async function sizeOf(dir: string): Promise<number | null> {
	try {
		const { stdout } = await run("du", ["-sk", dir], { timeout: 60_000 });
		return Number(stdout.split("\t")[0]) * 1024;
	} catch {
		return null;
	}
}

async function touchedAt(dir: string): Promise<number | null> {
	try {
		const gitdir = (await readFile(path.join(dir, ".git"), "utf8"))
			.replace(/^gitdir:\s*/, "")
			.trim();
		return (await stat(path.join(gitdir, "index"))).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Settings → Storage: every session worktree with what the pruner would do to
 * it. The script's --dry-run decides; nothing here second-guesses its rules.
 */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
	const script = storageScript();
	if (!script) return [];
	const perRepo = await Promise.all(
		(await reposWithWorktrees()).map(async (repo) => {
			const { stdout } = await runScript(script, ["--dry-run", repo]).catch(
				(error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
			);
			return Promise.all(
				parseVerdicts(stdout).map(async (verdict) => {
					const dir = worktreePath(repo, verdict.name);
					return {
						...verdict,
						repo,
						path: dir,
						prunedRef: prunedRef(verdict.name),
						sizeBytes: await sizeOf(dir),
						touchedAt: await touchedAt(dir),
					};
				}),
			);
		}),
	);
	return perRepo.flat();
}

/** Remove one worktree - only if the script, run on just that one, agrees, or forced. */
export async function removeWorktree(
	repo: string,
	name: string,
	/** Whatever it holds: the branch stays, uncommitted files go to refs/pruned. */
	force = false,
): Promise<boolean> {
	const script = storageScript();
	if (!script) return false;
	const { stdout } = await runScript(script, [
		"--only",
		name,
		...(force ? ["--force"] : []),
		repo,
	]);
	return parseVerdicts(stdout).some((v) => v.name === name && v.safe);
}
