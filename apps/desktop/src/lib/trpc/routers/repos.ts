import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "..";
import { readOdinConfig, updateOdinConfig } from "./odin-config";
import { type GhExec, ghAsAnyAccount } from "./terminal/pr-state";
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
 *
 * Desktop/Documents/Downloads are TCC-protected: descending into them makes
 * macOS throw a "would like to access files in your Desktop folder" prompt at
 * launch, three times over. Pruning by name means `find` never opens them, so
 * no prompt. A checkout parked on the Desktop won't be listed — add it through
 * the folder picker, which grants access without a prompt.
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

/** Enough diff to read; past this the renderer is the thing that suffers. */
const MAX_PATCH_BYTES = 1_000_000;

/** Feed `input` to a command's stdin; its stdout, or null if it failed. */
async function pipe(
	command: string,
	args: string[],
	input: string,
	extraEnv: Record<string, string> = {},
): Promise<string | null> {
	const env = await getProcessEnvWithShellPath();
	return new Promise((resolve) => {
		// Outside any checkout: inside one, `git apply` drops every path that
		// isn't under the current directory.
		const child = spawn(command, args, {
			cwd: tmpdir(),
			env: { ...env, ...extraEnv },
		});
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			out += chunk;
		});
		child.on("error", () => resolve(null));
		child.on("close", (code) => resolve(code === 0 ? out : null));
		// EPIPE if it died before reading the input — `error` already handled it.
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

/**
 * Delta, restyled for a panel rather than a pager: line numbers instead of the
 * boxed "1:" hunk headers, file names as quiet rules, and muted +/- fills so a
 * whole new file isn't a slab of green. Side by side once there's room for two
 * readable columns. Flags beat whatever ~/.gitconfig sets, so it looks the same
 * on every machine.
 */
function deltaArgs(width: number): string[] {
	return [
		"--paging=never",
		`--width=${width}`,
		"--line-numbers",
		...(width >= 200 ? ["--side-by-side"] : []),
		"--file-style=bold #e6e6ee",
		"--file-decoration-style=#3a3a48 ol ul",
		"--hunk-header-style=syntax",
		"--hunk-header-decoration-style=none",
		"--minus-style=syntax #3a1419",
		"--minus-emph-style=syntax #6e1f2a",
		"--plus-style=syntax #11301b",
		"--plus-emph-style=syntax #1d5c31",
		"--line-numbers-minus-style=#f0647a",
		"--line-numbers-plus-style=#4ade80",
		"--line-numbers-zero-style=#4a4a57",
		"--line-numbers-left-style=#2e2e38",
		"--line-numbers-right-style=#2e2e38",
		"--syntax-theme=OneHalfDark",
	];
}

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Without delta: git's own palette, by hand, since the patch is fetched plain. */
function colourPatch(patch: string): string {
	return patch
		.split("\n")
		.map((line) =>
			line.startsWith("diff --git")
				? `${BOLD}${line}${RESET}`
				: line.startsWith("@@")
					? `${CYAN}${line}${RESET}`
					: line.startsWith("+") && !line.startsWith("+++")
						? `${GREEN}${line}${RESET}`
						: line.startsWith("-") && !line.startsWith("---")
							? `${RED}${line}${RESET}`
							: line,
		)
		.join("\n");
}

/**
 * "Which files, how much" above the diff — the thing you read first and the
 * reason to scroll. `git apply --stat` reads any patch, so a PR's (which has
 * no local checkout) gets the same header as the working tree's.
 */
async function fileSummary(patch: string): Promise<string> {
	const stat = await pipe("git", ["apply", "--stat"], patch);
	if (!stat?.trim()) return "";
	const lines = stat.trimEnd().split("\n");
	const total = lines.pop() ?? "";
	return `${lines
		.map((line) =>
			line.replace(
				/(\|\s+\d+ )(\+*)(-*)$/,
				`${DIM}$1${RESET}${GREEN}$2${RED}$3${RESET}`,
			),
		)
		.join("\n")}\n${DIM}${total.trim()}${RESET}\n\n`;
}

/** The patch as the panel shows it: summary, then delta (or git colours). */
async function render(
	patch: string,
	width: number,
	note = "",
): Promise<Pick<RepoDiff, "ansi" | "delta">> {
	if (!patch.trim()) return { ansi: "", delta: true };
	const summary = await fileSummary(patch);
	if (patch.length > MAX_PATCH_BYTES) {
		patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n\n… diff truncated at ${MAX_PATCH_BYTES / 1000}kB\n`;
	}
	// Without COLORTERM delta drops to 256 colours, and its +/- fills land on
	// ANSI 22/52 — a whole added file comes out flooded bright green.
	const rendered = await pipe("delta", deltaArgs(width), patch, {
		COLORTERM: "truecolor",
	});
	return {
		ansi: note + summary + (rendered ?? colourPatch(patch)),
		delta: rendered !== null,
	};
}

export interface RepoDiff {
	/** Ready to write into a terminal: delta's output, or git's own colours. */
	ansi: string;
	/** Which diff this is, for the panel header. */
	source: string;
	/** False when delta isn't installed — the header says so. */
	delta: boolean;
	/** The checkout (or PR url) this is a diff of — the header names it. */
	cwd: string;
}

/**
 * What changed in a checkout, rendered for a terminal view.
 *
 * ponytail: `git diff HEAD` (staged + unstaged), falling back to the last
 * commit — an agent that already committed its turn would otherwise show an
 * empty panel. Untracked files are named, not diffed.
 *
 * @param since When the session started (ms). A clean tree is not proof the
 * agent committed its turn: checkouts are shared, so HEAD is usually a
 * stranger's commit from before this session existed. Only claim it when it
 * landed inside the session's window.
 */
export async function renderDiff(
	cwd: string,
	width: number,
	since?: number,
): Promise<RepoDiff> {
	const git = async (args: string[]) =>
		(
			await execWithShellEnv("git", ["--no-pager", ...args], {
				cwd,
				maxBuffer: 64 * 1024 * 1024,
				timeout: 30_000,
			})
		).stdout;

	let source = "uncommitted changes";
	let patch = await git(["diff", "--no-color", "HEAD"]);
	if (!patch.trim()) {
		// Empty on a repo with no commits at all — same answer as a commit that
		// predates the session: there is nothing of this session's to show.
		const committedAt =
			Number(await git(["log", "-1", "--format=%ct"]).catch(() => "")) * 1000;
		if (since && !(committedAt >= since)) {
			return {
				ansi: "",
				source: "nothing from this session",
				delta: true,
				cwd,
			};
		}
		source = "last commit";
		patch = await git(["show", "--no-color", "HEAD"]);
	}

	const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))
		.split("\n")
		.filter(Boolean);
	const note = untracked.length
		? `${DIM}${untracked.length} untracked file(s), not shown: ${untracked.slice(0, 3).join(", ")}${untracked.length > 3 ? ", …" : ""}${RESET}\n\n`
		: "";

	return { ...(await render(patch, width, note)), source, cwd };
}

/**
 * A pull request's diff, straight from GitHub — the PR may live in a repo (or
 * a worktree since deleted) that no checkout here still holds.
 */
export async function renderPullRequestDiff(
	url: string,
	width: number,
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
		...(await render(patch, width)),
		source: `${repo} PR #${number}`,
		cwd: url,
	};
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

		/**
		 * What a board card should call its repo. The pane only knows where it was
		 * launched, which for every feed-started session is the catch-all directory
		 * — so every card reads `dev` and the pill says nothing. The transcript
		 * knows where the agent actually went.
		 */
		workingRepoName: publicProcedure
			.input(z.object({ claudeSessionId: z.string() }))
			.query(async ({ input }) => {
				const { repoNameOf, workingRepoOf } = await import(
					"main/lib/claude-sessions"
				);
				const checkout = await workingRepoOf(input.claudeSessionId);
				return checkout ? { checkout, name: repoNameOf(checkout) } : null;
			}),

		diff: publicProcedure
			.input(
				z.object({
					/**
					 * The session's own checkout. Only known once its terminal has
					 * mounted — the workspace's is the fallback, which is where a
					 * session runs unless it picked a repo of its own.
					 */
					cwd: z.string().nullish(),
					/**
					 * The conversation running in this pane. Its transcript is the
					 * only record of which repo the agent actually worked in.
					 */
					claudeSessionId: z.string().nullish(),
					workspaceId: z.string(),
					/** Terminal columns to render at — delta assumes 80 when piped. */
					width: z.number().int().min(40).max(400).default(120),
					/** Show this pull request's diff instead of the checkout's. */
					pr: z.string().url().nullish(),
				}),
			)
			.query(async ({ input }) => {
				if (input.pr) return renderPullRequestDiff(input.pr, input.width);
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
				// When the conversation started, so a commit older than the session
				// isn't passed off as its work. birthtime is 0 on filesystems that
				// don't keep one — then the panel behaves as it did before.
				const transcript = input.claudeSessionId
					? await transcriptOf(input.claudeSessionId)
					: null;
				const since = transcript
					? statSync(transcript.path).birthtimeMs || undefined
					: undefined;
				return renderDiff(dir, input.width, since);
			}),
	});
};
