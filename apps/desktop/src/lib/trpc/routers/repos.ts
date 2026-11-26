import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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
export async function projectRepos(): Promise<string[]> {
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
 * Runs git in one checkout and resolves to its stdout. On a non-zero exit it
 * rejects with an error carrying `stdout`, as execFile does. This computer's
 * git by default; a remote host's session runs it on the host.
 */
export type GitRunner = (
	args: string[],
	env?: Record<string, string>,
) => Promise<string>;

/** `GitRunner` for a checkout on this computer. */
export const localGit =
	(cwd: string): GitRunner =>
	async (args, env) =>
		(
			await execWithShellEnv("git", args, {
				cwd,
				env,
				maxBuffer: 64 * 1024 * 1024,
				timeout: 60_000,
			})
		).stdout;

/** Most new files a diff lists in full; past it the note counts the rest. */
const MAX_UNTRACKED = 200;

/**
 * Files git doesn't track yet, each as an all-added patch, so a diff shows
 * the new files an agent wrote and not only its edits. `--no-index` reads the
 * working tree and never touches the index; it exits 1 when there is a
 * difference, which for a new file is always.
 */
async function untrackedFiles(
	git: GitRunner,
	paths: string[],
): Promise<{ files: DiffFile[]; note: string[] }> {
	const shown = paths.slice(0, MAX_UNTRACKED);
	const patches = await Promise.all(
		shown.map(async (path) => {
			const args = ["--no-pager", "diff", "--no-index", "--no-color"];
			try {
				return await git([...args, "--", "/dev/null", path]);
			} catch (error) {
				const stdout = (error as { stdout?: unknown }).stdout;
				return typeof stdout === "string" ? stdout : "";
			}
		}),
	);
	const rest = paths.length - shown.length;
	return {
		files: splitPatch(patches.join("")),
		note: rest ? [`${rest} more untracked file(s), not shown`] : [],
	};
}

/**
 * What changed in a checkout, file by file.
 *
 *
 * @param transcript The session's transcript. Checkouts are shared, so the
 * tree holds other sessions' edits and HEAD is often a stranger's commit -
 * made before this session, or by another one while it ran. The session owns
 * a commit whose sha its transcript printed (`git commit` does), and a file
 * whose path it named.
 */
export async function renderDiff(
	cwd: string,
	transcript?: string,
	wholeFile = false,
	run: GitRunner = localGit(cwd),
): Promise<RepoDiff> {
	const context = wholeFile ? ["-U1000000"] : [];
	const git = (args: string[]) => run(["--no-pager", ...args]);
	const nothing = {
		source: "nothing from this session",
		cwd,
		files: [],
		note: "",
	};

	let source = "uncommitted changes";
	let patch = await git(["diff", "--no-color", ...context, "HEAD"]);
	const ownsFile = (path: string) =>
		transcript === undefined || transcript.includes(path);
	const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))
		.split("\n")
		.filter((path) => path && ownsFile(path));
	if (
		!untracked.length &&
		(!patch.trim() || !splitPatch(patch).some((file) => ownsFile(file.path)))
	) {
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
		patch = await git(["show", "--no-color", ...context, "HEAD"]);
	}

	const all = splitPatch(patch);
	const tracked =
		source === "last commit" ? all : all.filter((file) => ownsFile(file.path));
	const added =
		source === "last commit"
			? { files: [], note: [] }
			: await untrackedFiles(run, untracked);
	const note = added.note;
	const others = all.length - tracked.length;
	if (others)
		note.push(`${others} file(s) changed by other sessions, not shown`);

	return { ...diffOf([...tracked, ...added.files], note), source, cwd };
}

/**
 * The checkout as it is now - edits and new files alike - written as a git
 * tree. A copy of the index takes the `add`, so the real index, the refs and
 * the files are never touched; the copy keeps git's stat cache, so only the
 * changed files get hashed.
 */
export async function snapshotTree(cwd: string): Promise<string> {
	const run = async (args: string[], env?: NodeJS.ProcessEnv) =>
		(
			await execWithShellEnv("git", args, {
				cwd,
				env,
				maxBuffer: 64 * 1024 * 1024,
				timeout: 60_000,
			})
		).stdout.trim();
	const index = resolve(cwd, await run(["rev-parse", "--git-path", "index"]));
	const dir = await mkdtemp(join(tmpdir(), "odin-review-"));
	const env = { GIT_INDEX_FILE: join(dir, "index") };
	try {
		if (existsSync(index)) await copyFile(index, env.GIT_INDEX_FILE);
		else await run(["read-tree", "HEAD"], env);
		await run(["add", "-A"], env);
		return await run(["write-tree"], env);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * What changed in a checkout since `since`, a tree `snapshotTree` wrote - the
 * agent's answer to a review, without the change the review was about.
 * New files show in full here, since both sides are trees.
 */
export async function renderSinceDiff(
	cwd: string,
	since: string,
	transcript?: string,
	wholeFile = false,
	run: GitRunner = localGit(cwd),
	snapshot: () => Promise<string> = () => snapshotTree(cwd),
): Promise<RepoDiff> {
	const now = await snapshot();
	const stdout = await run([
		"--no-pager",
		"diff",
		"--no-color",
		...(wholeFile ? ["-U1000000"] : []),
		since,
		now,
	]);
	const all = splitPatch(stdout);
	const files = all.filter(
		(file) => transcript === undefined || transcript.includes(file.path),
	);
	const others = all.length - files.length;
	return {
		...diffOf(
			files,
			others ? [`${others} file(s) changed by other sessions, not shown`] : [],
		),
		source: "since review",
		cwd,
	};
}

/**
 * Everything the branch changed since it left its base - its commits and any
 * edits not committed yet - with no PR needed. The base is the remote's
 * default branch (`origin/HEAD`), else `main` or `master`, remote first.
 */
export async function renderBranchDiff(
	cwd: string,
	wholeFile = false,
	run: GitRunner = localGit(cwd),
): Promise<RepoDiff> {
	const git = async (args: string[]) =>
		(await run(["--no-pager", ...args])).trim();
	const tryGit = (args: string[]) => git(args).catch(() => "");

	const branch =
		(await tryGit(["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD";
	const remoteDefault = await tryGit([
		"rev-parse",
		"--abbrev-ref",
		"origin/HEAD",
	]);
	const candidates = [
		remoteDefault,
		"origin/main",
		"origin/master",
		"main",
		"master",
	].filter((ref) => ref && ref !== "origin/HEAD" && ref !== branch);
	let base = "";
	let forkPoint = "";
	for (const ref of candidates) {
		forkPoint = await tryGit(["merge-base", "HEAD", ref]);
		if (forkPoint) {
			base = ref;
			break;
		}
	}
	if (!base) {
		return {
			source: `${branch} - no main or master branch to compare with`,
			cwd,
			files: [],
			note: "",
		};
	}

	const commits = Number(
		(await tryGit(["rev-list", "--count", `${forkPoint}..HEAD`])) || 0,
	);
	const patch = await git([
		"diff",
		"--no-color",
		...(wholeFile ? ["-U1000000"] : []),
		forkPoint,
	]);
	const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))
		.split("\n")
		.filter(Boolean);
	const added = await untrackedFiles(run, untracked);
	return {
		...diffOf([...splitPatch(patch), ...added.files], added.note),
		source: `${branch} vs ${base} · ${commits} ${commits === 1 ? "commit" : "commits"}`,
		cwd,
	};
}

/**
 * A pull request's diff, straight from GitHub - the PR may live in a repo (or
 * a worktree since deleted) that no checkout here still holds.
 */
export async function renderPullRequestDiff(
	url: string,
	exec?: GhExec,
	wholeFile = false,
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
	const [, , , owner, repo, , number] = url.split("/");
	const files = splitPatch(patch);
	const whole = wholeFile
		? await wholePullRequestFiles(`${owner}/${repo}`, number, files, exec)
		: { files, note: [] };
	return {
		...diffOf(whole.files, whole.note),
		source: `${repo} PR #${number}`,
		cwd: url,
	};
}

/** `fn` over `items`, a few at a time: each one is a gh process or two. */
async function inBatches<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	size = 6,
): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
	return out;
}

/** Most files a PR's whole-file view reads from GitHub; past it, only the changes. */
const MAX_WHOLE_PR_FILES = 60;

/** A PR file's path before and after, null on the side it doesn't exist. */
function pullRequestSides(file: DiffFile): {
	oldPath: string | null;
	newPath: string | null;
} {
	const header = file.patch.split("\n", 1)[0];
	const oldPath =
		/^rename from (.*)$/m.exec(file.patch)?.[1] ??
		/^--- a\/(.*)$/m.exec(file.patch)?.[1] ??
		header.match(/^diff --git a\/(.*) b\//)?.[1] ??
		null;
	return {
		oldPath: /^new file mode/m.test(file.patch) ? null : oldPath,
		newPath: /^deleted file mode/m.test(file.patch) ? null : file.path,
	};
}

/**
 * A PR's files with every line as context. GitHub's diff carries three lines
 * around each change and no more, so each changed file is read at the merge
 * base and at the head, and diffed here in a scratch repo. A file that can't
 * be read keeps its changes-only patch, and the note says how many.
 */
export async function wholePullRequestFiles(
	repo: string,
	number: string,
	files: DiffFile[],
	exec?: GhExec,
): Promise<{ files: DiffFile[]; note: string[] }> {
	const note: string[] = [];
	const api = (path: string, raw = false) =>
		ghAsAnyAccount(
			[
				"api",
				...(raw ? ["-H", "Accept: application/vnd.github.raw+json"] : []),
				path,
			],
			(stdout) => stdout,
			exec,
		);
	const pull = await api(`repos/${repo}/pulls/${number}`);
	const shas = pull
		? (JSON.parse(pull) as { base?: { sha?: string }; head?: { sha?: string } })
		: null;
	const compare =
		shas?.base?.sha && shas.head?.sha
			? await api(`repos/${repo}/compare/${shas.base.sha}...${shas.head.sha}`)
			: null;
	const base = compare
		? (JSON.parse(compare) as { merge_base_commit?: { sha?: string } })
				.merge_base_commit?.sha
		: undefined;
	const head = shas?.head?.sha;
	if (!base || !head) {
		note.push("GitHub didn't send the PR's commits - only the changes show");
		return { files, note };
	}

	const wanted = files
		.filter((file) => !file.binary)
		.slice(0, MAX_WHOLE_PR_FILES);
	const contentsAt = (path: string, ref: string) =>
		api(
			`repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
			true,
		);
	const read = await inBatches(wanted, async (file) => {
		const { oldPath, newPath } = pullRequestSides(file);
		const [before, after] = await Promise.all([
			oldPath ? contentsAt(oldPath, base) : "",
			newPath ? contentsAt(newPath, head) : "",
		]);
		if (before === null || after === null) return null;
		return { file, oldPath, newPath, before, after };
	});

	const dir = await mkdtemp(join(tmpdir(), "odin-pr-whole-"));
	const git = async (args: string[]) =>
		(
			await execWithShellEnv("git", args, {
				cwd: dir,
				maxBuffer: 64 * 1024 * 1024,
				timeout: 60_000,
			})
		).stdout.trim();
	const whole = new Map<string, DiffFile>();
	try {
		await git(["init", "-q"]);
		const snapshot = async (side: "before" | "after") => {
			await git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "."]);
			for (const entry of read) {
				const path = side === "before" ? entry?.oldPath : entry?.newPath;
				if (!entry || !path) continue;
				const target = resolve(dir, path);
				if (!target.startsWith(`${dir}${sep}`)) continue;
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, entry[side]);
				await git(["add", "-f", "--", path]);
			}
			return git(["write-tree"]);
		};
		const before = await snapshot("before");
		const after = await snapshot("after");
		const patch = await git([
			"--no-pager",
			"diff",
			"--no-color",
			"--no-renames",
			"-U1000000",
			before,
			after,
		]);
		for (const file of splitPatch(`${patch}\n`)) whole.set(file.path, file);
	} catch (error) {
		console.warn("[repos] whole PR files:", error);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}

	const shown = files.map((file) => {
		const entry = read[wanted.indexOf(file)];
		if (!entry) return file;
		// A deleted file is listed under its old path.
		const full = whole.get(entry.newPath ?? entry.oldPath ?? file.path);
		// Renames come back as a delete and an add: keep GitHub's patch there.
		if (
			!full ||
			(entry.oldPath && entry.newPath && entry.oldPath !== entry.newPath)
		)
			return file;
		return { ...file, patch: full.patch };
	});
	const partial = shown.filter(
		(file, index) => file === files[index] && !file.binary,
	).length;
	if (partial) note.push(`${partial} file(s) show only the changes`);
	return { files: shown, note };
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
		 * Settings → Running tasks; `DAN_DEFAULT_REPO` is only a fallback, so a path
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

		/** Settings → Storage: remove a worktree once its PR merges. */
		getPruneMerged: publicProcedure.query(
			() => readOdinConfig().pruneMergedWorktrees !== false,
		),

		setPruneMerged: publicProcedure
			.input(z.object({ enabled: z.boolean() }))
			.mutation(({ input }) => {
				updateOdinConfig({ pruneMergedWorktrees: input.enabled });
				return { ok: true };
			}),

		createSessionWorktree: publicProcedure
			.input(z.object({ repo: z.string(), title: z.string() }))
			.mutation(async ({ input }) => {
				const { createSessionWorktree } = await import(
					"main/lib/session-worktree"
				);
				return createSessionWorktree(input.repo, input.title);
			}),

		/** Skip Claude's folder-trust dialog in the folder a session runs in. */
		trustForClaude: publicProcedure
			.input(z.object({ path: z.string() }))
			.mutation(async ({ input }) => {
				const { trustForClaude, mainCheckoutOf } = await import(
					"main/lib/session-worktree"
				);
				const main = await mainCheckoutOf(input.path);
				await trustForClaude(
					main && main !== input.path ? [input.path, main] : [input.path],
				).catch((error) =>
					console.warn("[repos] could not trust", input.path, error),
				);
			}),

		reviveSessionWorktree: publicProcedure
			.input(z.object({ path: z.string() }))
			.mutation(async ({ input }) => {
				const { reviveSessionWorktree } = await import(
					"main/lib/session-worktree"
				);
				await reviveSessionWorktree(input.path).catch((error) =>
					console.warn("[repos] could not bring back", input.path, error),
				);
			}),

		/** Settings → Storage: every session worktree, its size and the pruner's verdict. */
		worktrees: publicProcedure.query(async () => {
			const { listWorktrees } = await import("main/lib/prune-worktrees");
			return listWorktrees();
		}),

		/** Removes what the pruner would, or anything when forced; returns the names it removed. */
		removeWorktrees: publicProcedure
			.input(
				z.array(
					z.object({
						repo: z.string(),
						name: z.string(),
						force: z.boolean().optional(),
					}),
				),
			)
			.mutation(async ({ input }) => {
				const { removeWorktree } = await import("main/lib/prune-worktrees");
				const removed: string[] = [];
				// One at a time: each run fetches the repo.
				for (const { repo, name, force } of input)
					if (await removeWorktree(repo, name, force))
						removed.push(`${repo}\0${name}`);
				return removed;
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
				const {
					ownerRepoOf,
					repoNameOf,
					transcriptOf,
					workingRepoOf,
					workingWorktreeOf,
				} = await import("main/lib/claude-sessions");
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
				return {
					checkout,
					owningClone: ownerRepoOf(checkout),
					name,
					worktree,
					pullRequests,
				};
			}),

		diff: publicProcedure
			.input(
				sessionCheckoutInput.extend({
					/** Show this pull request's diff instead of the checkout's. */
					pr: z.string().url().nullish(),
					/** The branch's commits and edits since its base, no PR needed. */
					branch: z.boolean().optional(),
					/** The whole of each file, not only the changed hunks. */
					wholeFile: z.boolean().optional(),
					/** Only what changed since this `reviewSnapshot` tree. */
					since: z
						.string()
						.regex(/^[0-9a-f]{40,64}$/)
						.nullish(),
				}),
			)
			.query(async ({ input }) => {
				if (input.pr)
					return renderPullRequestDiff(input.pr, undefined, input.wholeFile);
				return withSessionCheckout(
					input,
					({ dir, transcript, git, snapshot }) => {
						if (input.branch)
							return renderBranchDiff(dir, input.wholeFile, git);
						return input.since
							? renderSinceDiff(
									dir,
									input.since,
									transcript,
									input.wholeFile,
									git,
									snapshot,
								)
							: renderDiff(dir, transcript, input.wholeFile, git);
					},
				);
			}),

		/** A working-tree file of the session's checkout, for the Diff tab's Edit. */
		workingFile: publicProcedure
			.input(sessionCheckoutInput.extend({ path: z.string().min(1) }))
			.query(async ({ input }) => {
				const { dir } = await sessionCheckout(localOnly(input));
				return readWorkingFile(dir, input.path);
			}),

		/** Saves the Diff tab's Edit, unless the file changed on disk since it was read. */
		saveWorkingFile: publicProcedure
			.input(
				sessionCheckoutInput.extend({
					path: z.string().min(1),
					content: z.string().max(MAX_EDIT_BYTES),
					/** The mtime `workingFile` read; a later write on disk wins. */
					mtimeMs: z.number(),
				}),
			)
			.mutation(async ({ input }) => {
				const { dir } = await sessionCheckout(localOnly(input));
				return writeWorkingFile(dir, input.path, input.content, input.mtimeMs);
			}),

		/** The session's checkout as it is now, for a later `diff` `since` it. */
		reviewSnapshot: publicProcedure
			.input(sessionCheckoutInput)
			.mutation(async ({ input }) => {
				return withSessionCheckout(input, async ({ snapshot }) => ({
					tree: await snapshot(),
				}));
			}),
	});
};

/** Biggest file the Diff tab opens for editing: a textarea, not an IDE. */
const MAX_EDIT_BYTES = 2_000_000;

/** True when `rel` (from relative()) leaves its base or points into `.git`. */
function outsideCheckout(rel: string): boolean {
	return (
		!rel ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		rel.split(sep)[0] === ".git"
	);
}

/**
 * A diff's path (relative to the repo's top, as git prints it) as a file on
 * disk, or an error: it must stay inside the checkout and out of `.git` -
 * by name, and again once symlinks are followed, so a link in the repo can't
 * send a save somewhere else on the machine.
 */
export async function checkoutFilePath(
	dir: string,
	path: string,
): Promise<string> {
	const top = (
		await execWithShellEnv("git", ["rev-parse", "--show-toplevel"], {
			cwd: dir,
			timeout: 10_000,
		})
	).stdout.trim();
	const full = resolve(top, path);
	const refuse = () =>
		new TRPCError({
			code: "BAD_REQUEST",
			message: `${path} is not a file in this checkout.`,
		});
	if (outsideCheckout(relative(top, full))) throw refuse();
	// Missing (or a dangling link): the caller's stat finds nothing to edit.
	const real = await realpath(full).catch(() => null);
	if (real && outsideCheckout(relative(await realpath(top), real)))
		throw refuse();
	return real ?? full;
}

/**
 * The edited text with the file's own line endings: a textarea hands back
 * plain \n, so a CRLF file would otherwise be rewritten line by line.
 */
export function withLineEndingsOf(original: string, edited: string): string {
	const crlf = original.match(/\r\n/g)?.length ?? 0;
	const lf = (original.match(/\n/g)?.length ?? 0) - crlf;
	if (crlf === 0 || crlf < lf) return edited;
	return edited.replace(/\r?\n/g, "\r\n");
}

/** A text file's content and mtime, for editing it in the Diff tab. */
export async function readWorkingFile(
	dir: string,
	path: string,
): Promise<{ content: string; mtimeMs: number }> {
	const full = await checkoutFilePath(dir, path);
	const info = await stat(full).catch(() => null);
	if (!info?.isFile())
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `${path} isn't on disk - deleted files can't be edited.`,
		});
	if (info.size > MAX_EDIT_BYTES)
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${path} is too big to edit here (${Math.round(info.size / 1000)}kB).`,
		});
	const content = await readFile(full, "utf-8");
	if (content.includes("\0"))
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${path} is a binary file.`,
		});
	return { content, mtimeMs: info.mtimeMs };
}

/**
 * Writes the edited text back, unless something else (the agent, most
 * likely) wrote the file after it was read: then nothing is written and the
 * error says to reload, so neither edit is lost silently.
 */
export async function writeWorkingFile(
	dir: string,
	path: string,
	content: string,
	mtimeMs: number,
): Promise<{ mtimeMs: number }> {
	const full = await checkoutFilePath(dir, path);
	const info = await stat(full).catch(() => null);
	if (!info?.isFile())
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `${path} is no longer on disk.`,
		});
	if (Math.abs(info.mtimeMs - mtimeMs) > 1)
		throw new TRPCError({
			code: "CONFLICT",
			message: `${path} changed on disk after you opened it. Copy your edit, Cancel, and Edit again.`,
		});
	const original = await readFile(full, "utf-8");
	await writeFile(full, withLineEndingsOf(original, content), "utf-8");
	return { mtimeMs: (await stat(full)).mtimeMs };
}

const sessionCheckoutInput = z.object({
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
	/**
	 * The host the session runs on (its pane's `odinRemote`), else unset.
	 * Its checkout and transcript paths are the host's, so git runs there.
	 */
	host: z.string().nullish(),
});

type SessionCheckoutInput = z.infer<typeof sessionCheckoutInput>;

/** Edit reads and writes files on this computer; a host session's are not here. */
function localOnly(input: SessionCheckoutInput): SessionCheckoutInput {
	if (input.host)
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Edit works on sessions on this computer only.",
		});
	return input;
}

/** A session's checkout, with git and a snapshot that run where it lives. */
interface SessionGit {
	dir: string;
	transcript: string | undefined;
	git: GitRunner;
	snapshot: () => Promise<string>;
}

/**
 * Runs `fn` on the session's checkout: on this computer, or for a host
 * session on the host, over one connection. A host session's transcript is
 * mirrored here, but every folder it names is the host's - resolved here,
 * none of them exists, and the Diff tab fell back to the pane's folder on
 * this computer, showing that clone's uncommitted files instead of the
 * worktree's on the host.
 */
async function withSessionCheckout<T>(
	input: SessionCheckoutInput,
	fn: (checkout: SessionGit) => Promise<T>,
): Promise<T> {
	if (!input.host) {
		const { dir, transcript } = await sessionCheckout(input);
		return fn({
			dir,
			transcript,
			git: localGit(dir),
			snapshot: () => snapshotTree(dir),
		});
	}
	const [{ withSessionHost }, hostGitModule, sessions] = await Promise.all([
		import("./remote-host"),
		import("main/lib/remote-host/host-git"),
		import("main/lib/claude-sessions"),
	]);
	const { clientExec, hostCheckouts, hostGit, hostSnapshot } = hostGitModule;
	const found = input.claudeSessionId
		? await sessions.transcriptOf(input.claudeSessionId)
		: null;
	const transcript = found ? await readFile(found.path, "utf-8") : undefined;
	return withSessionHost(input.host, async (client) => {
		const exec = clientExec(client);
		const id = input.claudeSessionId;
		let dir: string | null = null;
		if (id && transcript !== undefined) {
			const checkouts = await hostCheckouts(
				exec,
				sessions.transcriptDirs(transcript),
			);
			const root = sessions.projectsRoot();
			dir =
				(await sessions.workingWorktreeOf(id, root, checkouts)) ??
				(await sessions.workingRepoOf(id, root, checkouts));
		}
		dir ??= input.cwd ?? null;
		if (!dir)
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "No checkout known for this session on its host yet.",
			});
		const checkout = dir;
		return fn({
			dir: checkout,
			transcript,
			git: hostGit(exec, checkout),
			snapshot: () => hostSnapshot(exec, checkout),
		});
	});
}

/** The checkout a session's changes are in, and its transcript's text. */
async function sessionCheckout(
	input: z.infer<typeof sessionCheckoutInput>,
): Promise<{ dir: string; transcript: string | undefined }> {
	// The repo the agent worked in wins: Claude Code cds between repos
	// and worktrees without the shell ever noticing, so `input.cwd` is
	// often just the catch-all directory the pane was launched in.
	// The worktree before the clone: an agent runs most of its commands in
	// the clone before it cuts a worktree, but the changes are in the worktree.
	const { transcriptOf, workingRepoOf, workingWorktreeOf } = await import(
		"main/lib/claude-sessions"
	);
	const dir =
		(input.claudeSessionId
			? ((await workingWorktreeOf(input.claudeSessionId)) ??
				(await workingRepoOf(input.claudeSessionId)))
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
	return {
		dir,
		transcript: transcript
			? await readFile(transcript.path, "utf-8")
			: undefined,
	};
}
