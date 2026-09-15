import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { publicProcedure, router } from "..";

/**
 * Odin fork: the git checkouts on this machine, so the session composer can
 * point a session at a repo instead of the default workspace.
 *
 * ponytail: one depth-capped `find` under $HOME, scanned once at launch and
 * cached for the app's lifetime — a new clone shows up after a restart. Swap
 * for a watcher only if that ever bites.
 */
const run = promisify(execFile);

/**
 * Skipped wholesale: vendored copies, macOS's junk drawer, and every dot-dir —
 * tool caches (~/.claude, ~/.cache), editor plugins and Odin's worktrees
 * all hide there, and none of them is a repo you'd start a session in.
 *
 * Desktop/Documents/Downloads are TCC-protected: descending into them makes
 * macOS throw a "would like to access files in your Desktop folder" prompt at
 * launch, three times over. Pruning by name means `find` never opens them, so
 * no prompt. A checkout parked on the Desktop won't be listed — add it through
 * the folder picker, which grants access without a prompt.
 */
const PRUNED = [
	"node_modules",
	"venv",
	"Library",
	"Applications",
	"Desktop",
	"Documents",
	"Downloads",
	".*",
];

export async function scanRepos(home: string = homedir()): Promise<string[]> {
	const args = [
		home,
		"-maxdepth",
		"6",
		// The .git test comes first, so pruning dot-dirs doesn't eat it.
		"-name",
		".git",
		"-print",
		"-prune",
		"-o",
		"(",
		...PRUNED.flatMap((name, index) =>
			index === 0 ? ["-name", name] : ["-o", "-name", name],
		),
		")",
		"-prune",
	];
	// `find` exits non-zero on any unreadable directory but still prints the
	// rest, so a partial result is the normal case, not a failure.
	const stdout = await run("find", args, { maxBuffer: 16 * 1024 * 1024 })
		.then((result) => result.stdout)
		.catch((error: { stdout?: string }) => error.stdout ?? "");
	return [...new Set(stdout.split("\n").filter(Boolean).map(dirname))].sort();
}

export const createReposRouter = () => {
	const repos = scanRepos();
	return router({
		list: publicProcedure.query(() => repos),
	});
};
