import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "..";
import { readOdinConfig, updateOdinConfig } from "./odin-config";
import {
	type GhExec,
	ghAsAnyAccount,
	pullRequestWorktrees,
} from "./terminal/pr-state";
import { getWorkspaceTerminalContext } from "./terminal/utils/workspace-terminal-context";
import { execWithShellEnv } from "./workspaces/utils/shell-env";

/**
 * Odin fork: the git checkouts on this machine, so the session composer can
 * point a session at a repo instead of the default workspace.
 *
 * ponytail: one depth-capped `find` under $HOME, scanned once at launch and
 * cached for the app's lifetime - a new clone shows up after a restart. Swap
 * for a watcher only if that ever bites.
 */
const run = promisify(execFile);

/**
 * Skipped wholesale: vendored copies, macOS's junk drawer, and every dot-dir -
 * tool caches (~/.claude, ~/.cache), editor plugins and Odin's worktrees
 * all hide there, and none of them is a repo you'd start a session in.
 *
 * Desktop/Documents/Downloads are TCC-protected: descending into them makes
 * macOS throw a "would like to access files in your Desktop folder" prompt at
 * launch, three times over. Pruning by name means `find` never opens them, so
 * no prompt. A checkout parked there is listed once it's added through the
 * folder picker, which grants access without a prompt - see `projectRepos`.
 *
 * Music/Pictures/Movies are the same story with louder prompts: they hold the
 * Apple Music, Photos and TV libraries, so walking them asks for access to
 * "your music and video activity" or your photos. Odin has no business with
 * any of that, and nobody keeps a checkout in their Photos library.
 */
const PRUNED = [
	"node_modules",
	"venv",
	"Library",
	"Applications",
	"Desktop",
	"Documents",
	"Downloads",
	"Music",
	"Pictures",
	"Movies",
	".*",
];

export async function scanRepos(home: string = homedir()): Promise<string[]> {
	const args = [
		home,
		"-maxdepth",
		"6",
		// The .git test comes first, so pruning dot-dirs doesn't eat it.
		// `-type d` drops worktrees and submodules, where .git is a file: they
		// share a clone's history, so listing them just triples the picker.
		"-name",
		".git",
		"-type",
		"d",
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

/**
 * The folders added as projects. The scan can't see a checkout under a
 * TCC-protected folder (~/Documents/GitHub/...), so without these the picker
 * never offers it. Read per call, so a folder added a moment ago shows up.
 * Imported lazily: local-db pulls in Electron, which the tests don't have.
 */
async function projectRepos(): Promise<string[]> {
	const { projects } = await import("@odin/local-db");
	const { localDb } = await import("main/lib/local-db");
	return localDb
		.select({ path: projects.mainRepoPath })
		.from(projects)
		.all()
		.map((row) => row.path)
		.filter((path) => existsSync(join(path, ".git")));
}

/**
 * Where the checkouts live: the folder right under home that holds the most of
 * them (`~/dev` for `~/dev/odin`, `~/dev/work/api`, ...). A repo sitting
 * directly in home doesn't count - home itself is never the answer.
 */
export function detectReposFolder(
	repos: string[],
	home: string = homedir(),
): string | null {
	const counts = new Map<string, number>();
	for (const repo of repos) {
		const rest = relative(home, repo).split(sep);
		if (rest.length < 2 || rest[0] === "..") continue;
		const top = join(home, rest[0]);
		counts.set(top, (counts.get(top) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Enough diff to read; past this the renderer is the thing that suffers. */
const MAX_PATCH_BYTES = 1_000_000;

/** One file of a diff: the list's row, and the patch the panel renders. */
export interface DiffFile {
	path: string;
	added: number;
	removed: number;
	/** No text diff to show - an image, an .icns. The list says so. */
	binary: boolean;
	/** This file's `diff --git` section, as git printed it. */
	patch: string;
}

/**
 * A patch cut at each `diff --git`. Whatever precedes the first one (a
 * commit's header, from `git show`) has no path and is dropped.
 */
export function splitPatch(patch: string): DiffFile[] {
	return patch
		.split(/^(?=diff --git )/m)
		.map((text) => {
			const lines = text.split("\n");
			const header = lines[0].match(/^diff --git a\/.* b\/(.*)$/);
			return {
				path: header?.[1] ?? "",
				patch: text,
				added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
					.length,
				removed: lines.filter((l) => l.startsWith("-") && !l.startsWith("---"))
					.length,
				// `git diff` says "Binary files … differ"; with --binary, a GIT binary patch.
				binary: /^(Binary files |GIT binary patch)/m.test(text),
			};
		})
		.filter((file) => file.path);
}

/** Whole files up to MAX_PATCH_BYTES - a file cut mid-hunk wouldn't parse. */
function capped(files: DiffFile[]): { files: DiffFile[]; dropped: number } {
	let bytes = 0;
	const kept = files.filter((file) => {
		bytes += file.patch.length;
		return bytes <= MAX_PATCH_BYTES || file === files[0];
	});
	return { files: kept, dropped: files.length - kept.length };
}

export interface RepoDiff {
	/** Which diff this is, for the panel header. */
	source: string;
	/** The checkout (or PR url) this is a diff of - the header names it. */
	cwd: string;
	/** Every file in it, in order. */
	files: DiffFile[];
	/** What the panel should say that no file shows: untracked or dropped files. */
	note: string;
}

function diffOf(all: DiffFile[], note: string[] = []) {
	const { files, dropped } = capped(all);
	if (dropped)
		note.push(
			`${dropped} more file(s) past ${MAX_PATCH_BYTES / 1000}kB, not shown`,
		);
	return { files, note: note.join(" · ") };
}

/**
 * What changed in a checkout, file by file.
 *
 * ponytail: `git diff HEAD` (staged + unstaged), falling back to the last
 * commit - an agent that already committed its turn would otherwise show an
 * empty panel. Untracked files are named, not diffed.
 *
 * @param transcript The session's transcript. Checkouts are shared, so the
 * tree holds other sessions' edits and HEAD is often a stranger's commit -
 * made before this session, or by another one while it ran. The session owns
 * a commit whose sha its transcript printed (`git commit` does), and a file
 * whose path it named. ponytail: a file the session changed without naming it
 * (a lockfile from an install) is hidden too - the note counts it.
 */
export async function renderDiff(
	cwd: string,
	transcript?: string,
): Promise<RepoDiff> {
	const git = async (args: string[]) =>
		(
			await execWithShellEnv("git", ["--no-pager", ...args], {
				cwd,
				maxBuffer: 64 * 1024 * 1024,
				timeout: 30_000,
			})
		).stdout;
	const nothing = {
		source: "nothing from this session",
		cwd,
		files: [],
		note: "",
	};

	let source = "uncommitted changes";
	let patch = await git(["diff", "--no-color", "HEAD"]);
	const ownsFile = (path: string) =>
		transcript === undefined || transcript.includes(path);
	if (!patch.trim() || !splitPatch(patch).some((file) => ownsFile(file.path))) {
		// Empty on a repo with no commits at all - same answer as a commit that
		// isn't this session's: there is nothing of its to show.
		const sha = (await git(["rev-parse", "HEAD"]).catch(() => "")).trim();
		if (
			!sha ||
			(transcript !== undefined && !transcript.includes(sha.slice(0, 7)))
		) {
			return nothing;
		}
		source = "last commit";
		patch = await git(["show", "--no-color", "HEAD"]);
	}

	const all = splitPatch(patch);
	const files =
		source === "last commit" ? all : all.filter((file) => ownsFile(file.path));
	const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))
		.split("\n")
		.filter((path) => path && ownsFile(path));
	const note = untracked.length
		? [
				`${untracked.length} untracked file(s), not shown: ${untracked.slice(0, 3).join(", ")}${untracked.length > 3 ? ", …" : ""}`,
			]
		: [];
	const others = all.length - files.length;
	if (others)
		note.push(`${others} file(s) changed by other sessions, not shown`);

	return { ...diffOf(files, note), source, cwd };
}

/**
 * A pull request's diff, straight from GitHub - the PR may live in a repo (or
 * a worktree since deleted) that no checkout here still holds.
 */
export async function renderPullRequestDiff(
	url: string,
	exec?: GhExec,
): Promise<RepoDiff> {
	const patch = await ghAsAnyAccount(
		["pr", "diff", url, "--color=never"],
		(stdout) => stdout,
		exec,
	);
	if (patch === null) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `No logged-in gh account can read ${url}`,
		});
	}
	// https://github.com/<owner>/<repo>/pull/<n>
	const [, , , , repo, , number] = url.split("/");
	return {
		...diffOf(splitPatch(patch)),
		source: `${repo} PR #${number}`,
		cwd: url,
	};
}

export const createReposRouter = (
	added: () => Promise<string[]> = projectRepos,
) => {
	const repos = scanRepos();
	return router({
		list: publicProcedure.query(async () =>
			[...new Set([...(await repos), ...(await added())])].sort(),
		),

		/**
		 * The checkout a session starts in when nothing else names one. Set in
		 * Settings → Sessions; `DAN_DEFAULT_REPO` is only a fallback, so a path
		 * picked in the UI is never shadowed by a stale shell export. Neither set:
		 * the folder the repos live in, detected.
		 */
		getDefault: publicProcedure.query(
			async () =>
				readOdinConfig().defaultRepo ??
				process.env.DAN_DEFAULT_REPO ??
				detectReposFolder(await repos),
		),

		setDefault: publicProcedure
			.input(z.object({ path: z.string().nullable() }))
			.mutation(({ input }) => {
				// Any folder will do - git or not. Checked here rather than at
				// launch, where a missing path only fails much later.
				if (input.path && !existsSync(input.path)) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `No such folder: ${input.path}`,
					});
				}
				// `undefined` deletes the key - that's what clearing it means.
				updateOdinConfig({ defaultRepo: input.path ?? undefined });
				return { ok: true };
			}),

		/**
		 * What a board card should call its repo. The pane only knows where it was
		 * launched, which for every feed-started session is the catch-all directory
		 * - so every card reads `dev` and the pill says nothing. The transcript
		 * knows where the agent actually went.
		 */
		workingRepoName: publicProcedure
			.input(z.object({ claudeSessionId: z.string() }))
			.query(async ({ input }) => {
				const { repoNameOf, transcriptOf, workingRepoOf, workingWorktreeOf } =
					await import("main/lib/claude-sessions");
				const checkout = await workingRepoOf(input.claudeSessionId);
				if (!checkout) return null;
				const name = repoNameOf(checkout);
				const transcript = await transcriptOf(input.claudeSessionId);
				// The PRs' branches are the sure signal; the transcript's cwds rarely
				// show a worktree at all.
				const pullRequests = transcript
					? await pullRequestWorktrees(
							await readFile(transcript.path, "utf-8"),
							checkout,
						)
					: [];
				const worktree =
					pullRequests[0]?.worktree ??
					(await workingWorktreeOf(input.claudeSessionId));
				return { checkout, name, worktree, pullRequests };
			}),

		diff: publicProcedure
			.input(
				z.object({
					/**
					 * The session's own checkout. Only known once its terminal has
					 * mounted - the workspace's is the fallback, which is where a
					 * session runs unless it picked a repo of its own.
					 */
					cwd: z.string().nullish(),
					/**
					 * The conversation running in this pane. Its transcript is the
					 * only record of which repo the agent actually worked in.
					 */
					claudeSessionId: z.string().nullish(),
					workspaceId: z.string(),
					/** Show this pull request's diff instead of the checkout's. */
					pr: z.string().url().nullish(),
				}),
			)
			.query(async ({ input }) => {
				if (input.pr) return renderPullRequestDiff(input.pr);
				// The repo the agent worked in wins: Claude Code cds between repos
				// and worktrees without the shell ever noticing, so `input.cwd` is
				// often just the catch-all directory the pane was launched in.
				const { transcriptOf, workingRepoOf } = await import(
					"main/lib/claude-sessions"
				);
				const dir =
					(input.claudeSessionId
						? await workingRepoOf(input.claudeSessionId)
						: null) ??
					input.cwd ??
					getWorkspaceTerminalContext(input.workspaceId).workspacePath;
				if (!dir) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "No checkout known for this session yet.",
					});
				}
				// What the session did, so another session's work in the same
				// checkout isn't passed off as its own.
				const transcript = input.claudeSessionId
					? await transcriptOf(input.claudeSessionId)
					: null;
				return renderDiff(
					dir,
					transcript ? await readFile(transcript.path, "utf-8") : undefined,
				);
			}),
	});
};
