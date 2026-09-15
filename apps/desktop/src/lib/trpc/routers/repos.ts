import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "..";
import { getWorkspaceTerminalContext } from "./terminal/utils/workspace-terminal-context";
import {
	execWithShellEnv,
	getProcessEnvWithShellPath,
} from "./workspaces/utils/shell-env";

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
 */
const PRUNED = ["node_modules", "venv", "Library", "Applications", ".*"];

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

/** Enough diff to read; past this the renderer is the thing that suffers. */
const MAX_PATCH_BYTES = 1_000_000;

/**
 * Pipe a patch through delta. Returns null when delta isn't installed (or
 * chokes) — the caller already holds git's own coloured output, so the panel
 * degrades to a plain coloured diff instead of an error.
 */
async function throughDelta(
	patch: string,
	width: number,
): Promise<string | null> {
	const env = await getProcessEnvWithShellPath();
	return new Promise((resolve) => {
		const child = spawn("delta", ["--paging=never", `--width=${width}`], {
			// Without COLORTERM delta drops to 256 colours, and its +/- fills land
			// on ANSI 22/52 — a whole added file comes out flooded bright green.
			env: { ...env, COLORTERM: "truecolor" },
		});
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
		});
		child.on("error", () => resolve(null));
		child.on("close", (code) => resolve(code === 0 ? out : null));
		// EPIPE if delta died before reading the patch — `error` already handled it.
		child.stdin.on("error", () => {});
		child.stdin.end(patch);
	});
}

export interface RepoDiff {
	/** Ready to write into a terminal: delta's output, or git's own colours. */
	ansi: string;
	/** Which diff this is, for the panel header. */
	source: string;
	/** False when delta isn't installed — the header says so. */
	delta: boolean;
}

/**
 * What changed in a checkout, rendered for a terminal view.
 *
 * ponytail: `git diff HEAD` (staged + unstaged), falling back to the last
 * commit — an agent that already committed its turn would otherwise show an
 * empty panel. Untracked files are named, not diffed.
 */
export async function renderDiff(
	cwd: string,
	width: number,
): Promise<RepoDiff> {
	const git = async (args: string[]) =>
		(
			await execWithShellEnv("git", ["-c", "color.ui=always", ...args], {
				cwd,
				maxBuffer: 64 * 1024 * 1024,
				timeout: 30_000,
			})
		).stdout;

	let source = "uncommitted changes";
	let patch = await git(["diff", "HEAD"]);
	if (!patch.trim()) {
		source = "last commit";
		patch = await git(["show", "HEAD"]);
	}
	if (patch.length > MAX_PATCH_BYTES) {
		patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n\n… diff truncated at ${MAX_PATCH_BYTES / 1000}kB\n`;
	}

	const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))
		.split("\n")
		.filter(Boolean);
	const note = untracked.length
		? `${untracked.length} untracked file(s), not shown: ${untracked.slice(0, 3).join(", ")}${untracked.length > 3 ? ", …" : ""}\n\n`
		: "";

	const rendered = await throughDelta(patch, width);
	return {
		ansi: note + (rendered ?? patch),
		source,
		delta: rendered !== null,
	};
}

export const createReposRouter = () => {
	const repos = scanRepos();
	return router({
		list: publicProcedure.query(() => repos),
		diff: publicProcedure
			.input(
				z.object({
					/**
					 * The session's own checkout. Only known once its terminal has
					 * mounted — the workspace's is the fallback, which is where a
					 * session runs unless it picked a repo of its own.
					 */
					cwd: z.string().nullish(),
					workspaceId: z.string(),
					/** Terminal columns to render at — delta assumes 80 when piped. */
					width: z.number().int().min(40).max(400).default(120),
				}),
			)
			.query(({ input }) => {
				const dir =
					input.cwd ??
					getWorkspaceTerminalContext(input.workspaceId).workspacePath;
				if (!dir) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "No checkout known for this session yet.",
					});
				}
				return renderDiff(dir, input.width);
			}),
	});
};
