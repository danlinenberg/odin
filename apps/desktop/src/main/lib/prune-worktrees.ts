import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
	readOdinConfig,
	resolveGithubToken,
} from "lib/trpc/routers/odin-config";
import { scanRepos } from "lib/trpc/routers/repos";

/**
 * Remove session worktrees whose PR already merged or closed - each one is a
 * full install, and sessions leave them in every repo they work in: 79 dead
 * ones across a dozen repos filled the disk. The rules live in
 * scripts/prune-worktrees.sh, which is also runnable by hand with --dry-run.
 *
 * Every repo on the machine with a `.worktrees/` gets a pass. The script comes
 * from the Odin checkout (`odinRepo` in odin.json), so an install with no
 * checkout does nothing. GitHub's token comes from Settings → Connections: it
 * lets the script tell a merged PR from unmerged work when main has since
 * changed the same files; repos it can't see fall back to gh's own logins.
 */
// Settings → Sessions turns this off; read every pass, so no restart needed.
const EVERY_MS = 10 * 60 * 1000;
const FIRST_RUN_MS = 5 * 60 * 1000;

const run = promisify(execFile);

// ponytail: scanned once per launch, like the session picker - a repo cloned
// since then gets its pass after a restart.
let repos: Promise<string[]> | null = null;

async function prune(): Promise<void> {
	const odinRepo = process.env.ODIN_REPO_DIR ?? readOdinConfig().odinRepo;
	const script = odinRepo && path.join(odinRepo, "scripts/prune-worktrees.sh");
	if (!script || !existsSync(script)) return;
	if (readOdinConfig().pruneMergedWorktrees === false) return;
	repos ??= scanRepos();
	const token = resolveGithubToken();
	// One repo at a time: each pass fetches and asks GitHub about every branch.
	for (const repo of await repos) {
		if (!existsSync(path.join(repo, ".worktrees"))) continue;
		try {
			const { stdout } = await run(script, [repo], {
				env: {
					...process.env,
					// Merged means gone at the next pass, not an hour later.
					PRUNE_LANDED_MIN_AGE_HOURS: "0",
					...(token ? { GH_TOKEN: token } : {}),
				},
				timeout: 5 * 60 * 1000,
			});
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
