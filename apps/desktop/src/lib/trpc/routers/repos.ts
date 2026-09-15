import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "..";
import { readOdinConfig, updateOdinConfig } from "./odin-config";

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

		/**
		 * The checkout a session starts in when nothing else names one. Set in
		 * Settings → Connections; `DAN_DEFAULT_REPO` is only a fallback, so a
		 * path picked in the UI is never shadowed by a stale shell export.
		 */
		getDefault: publicProcedure.query(
			() =>
				readOdinConfig().defaultRepo ?? process.env.DAN_DEFAULT_REPO ?? null,
		),

		setDefault: publicProcedure
			.input(z.object({ path: z.string().nullable() }))
			.mutation(({ input }) => {
				// Checked here rather than at launch: a path that isn't a checkout
				// only fails much later, when a session tries to start in it.
				// `.git` is a file in a worktree and a directory in a clone.
				if (input.path && !existsSync(join(input.path, ".git"))) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Not a git repo: ${input.path}`,
					});
				}
				// `undefined` deletes the key — that's what clearing it means.
				updateOdinConfig({ defaultRepo: input.path ?? undefined });
				return { ok: true };
			}),
	});
};
