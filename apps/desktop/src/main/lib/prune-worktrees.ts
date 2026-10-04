import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
	readOdinConfig,
	resolveGithubToken,
} from "lib/trpc/routers/odin-config";

/**
 * Remove session worktrees whose PR already merged - each one is a full
 * `bun install`, and fifteen of them filled the disk. The rules live in
 * scripts/prune-worktrees.sh, which is also runnable by hand with --dry-run.
 *
 * Runs from the Odin checkout (`odinRepo` in odin.json), so an install with no
 * checkout does nothing. GitHub's token comes from Settings → Connections: it
 * lets the script tell a merged PR from unmerged work when main has since
 * changed the same files.
 */
// Hourly: landed work is removable an hour after its last commit.
const EVERY_MS = 60 * 60 * 1000;
const FIRST_RUN_MS = 5 * 60 * 1000;

function prune(): void {
	const repo = process.env.ODIN_REPO_DIR ?? readOdinConfig().odinRepo;
	const script = repo && path.join(repo, "scripts/prune-worktrees.sh");
	if (!script || !existsSync(script)) return;
	const token = resolveGithubToken();
	execFile(
		script,
		[repo],
		{
			env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
			timeout: 5 * 60 * 1000,
		},
		(error, stdout, stderr) => {
			if (error) {
				console.warn("[main] prune-worktrees failed:", stderr || error.message);
				return;
			}
			const removed = stdout.split("\n").filter((l) => l.startsWith("remove"));
			if (removed.length)
				console.warn(`[main] prune-worktrees:\n${removed.join("\n")}`);
		},
	);
}

export function startWorktreePruner(): void {
	setTimeout(() => {
		prune();
		setInterval(prune, EVERY_MS).unref();
	}, FIRST_RUN_MS).unref();
}
