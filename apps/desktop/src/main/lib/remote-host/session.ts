import stripAnsi from "strip-ansi";

/**
 * The scripts a session on a remote host runs. A pane on the laptop runs the
 * remote-shell helper, which opens two SSH channels over SSM:
 *
 * 1. `stashScript`, with no terminal: the user's tokens arrive on its stdin and
 *    land in a 0600 file under /dev/shm (memory). They are never typed into a
 *    terminal (it would echo them) or put on a command line (`ps` shows those).
 * 2. `attachScript`, in a terminal: reattaches to the session's tmux session,
 *    or starts one that reads and deletes the tokens, clones the repo if the
 *    host has none, and runs Claude. tmux keeps it running with the laptop shut.
 */

export interface RemoteSessionSpec {
	instanceId: string;
	profile?: string | null;
	region?: string | null;
	user: string;
	/** The Odin pane; its tmux session is `odin-<pane>`. */
	pane: string;
	/** Where the host keeps its clones, e.g. ~/repos. */
	reposRoot: string;
	/** The repo's folder name under reposRoot; null starts in reposRoot. */
	repoName: string | null;
	/** https clone URL, used when the host has no clone yet. */
	cloneUrl: string | null;
	/** Claude's arguments without the prompt, already shell-quoted. */
	claudeArgs: string;
	/** The opening prompt, sent as base64 so no quoting can break it. */
	prompt: string | null;
	/** Odin's pane on the laptop, so the session's calls to Odin name it. */
	odinPane?: string | null;
	/** Laptop files the prompt names, copied to the host before Claude starts. */
	files?: RemoteFile[];
}

export interface RemoteFile {
	local: string;
	/** Relative to the host user's home, where SFTP starts. */
	remote: string;
}

/**
 * The host's port for Odin's local server: the helper forwards it back to
 * the laptop, so `curl 127.0.0.1:$ODIN_PORT` on the host reaches Odin.
 */
export const REMOTE_ODIN_PORT = 47187;

/** The host user's home, for absolute paths Claude's file tools accept. */
export const hostHome = (user: string) =>
	user === "root" ? "/root" : `/home/${user}`;

/** The session's own worktree and branch, named after its conversation. */
export const sessionBranch = (pane: string) => `odin/${pane.slice(0, 8)}`;
const worktreeDir = (pane: string) => `odin-${pane.slice(0, 8)}`;

/** Single-quote for a POSIX shell. */
export const sh = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** `~/x` as `"$HOME"/x`, so the shell expands it inside quotes too. */
const homePath = (path: string) =>
	path === "~"
		? '"$HOME"'
		: path.startsWith("~/")
			? `"$HOME"/${sh(path.slice(2))}`
			: sh(path);

export const tmuxSession = (pane: string) =>
	`odin-${pane.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60)}`;

/** The tokens' file, as `KEY='value'` lines the run script sources. */
export function secretsFile(env: Record<string, string | undefined>): string {
	return Object.entries(env)
		.filter((entry): entry is [string, string] => Boolean(entry[1]))
		.map(([key, value]) => `${key}=${sh(value)}\n`)
		.join("");
}

/** Reads the tokens from stdin into a fresh 0600 dir in /dev/shm; prints the dir. */
export const stashScript =
	'umask 077; d=$(mktemp -d -p /dev/shm odin.XXXXXX) && cat > "$d/env" && echo "$d"';

/**
 * A host's first Claude stops at the theme picker and then the folder-trust
 * question, with nobody watching. Mark both answered in ~/.claude.json, for
 * the folder the session starts in (argv[1]).
 */
const SKIP_FIRST_RUN = `import json, os, sys
p = os.path.expanduser("~/.claude.json")
try:
    c = json.load(open(p))
except Exception:
    c = {}
c.setdefault("hasCompletedOnboarding", True)
c.setdefault("theme", "dark")
c.setdefault("projects", {}).setdefault(sys.argv[1], {})["hasTrustDialogAccepted"] = True
json.dump(c, open(p, "w"), indent=2)`;

/**
 * The GitHub CLI, so the agent can open PRs from the host. Installed into the
 * user's ~/.local/bin when missing, pinned by SHA-256; GH_TOKEN signs it in.
 */
const GH_VERSION = "2.60.1";
const GH_SHA256: Record<string, string> = {
	amd64: "dfcd9926de38a797e88e604c3111ecf9ddf13c524706712b2b0d2e2fc4a6ed7f",
	arm64: "a2842ed6d1f9e260043305749383bb1eb77d817bb57e22cf8c01da0a48caff66",
};
export const ghInstallScript = [
	"if ! command -v gh >/dev/null; then",
	'  case "$(uname -m)" in aarch64|arm64) a=arm64;; *) a=amd64;; esac',
	`  [ "$a" = arm64 ] && sum=${GH_SHA256.arm64} || sum=${GH_SHA256.amd64}`,
	`  f=gh_${GH_VERSION}_linux_$a; t=$(mktemp -d)`,
	`  curl -fsSL -o "$t/gh.tgz" "https://github.com/cli/cli/releases/download/v${GH_VERSION}/$f.tar.gz" &&`,
	'  echo "$sum  $t/gh.tgz" | sha256sum -c --quiet &&',
	'  tar -xzf "$t/gh.tgz" -C "$t" && mkdir -p "$HOME/.local/bin" && mv "$t/$f/bin/gh" "$HOME/.local/bin/gh"',
	'  rm -rf "$t"',
	"fi",
].join("\n");

/** What runs inside tmux: tokens in, file gone, repo ready, Claude on. */
export function runScript(spec: RemoteSessionSpec, secretsDir: string): string {
	const root = homePath(spec.reposRoot);
	const repo = spec.repoName ? `${root}/${sh(spec.repoName)}` : root;
	// Every session gets its own worktree, so two on one repo never collide;
	// a resume finds the same one by name.
	const worktree = `${repo}/.worktrees/${sh(worktreeDir(spec.pane))}`;
	const prompt = spec.prompt
		? ` "$(printf %s ${sh(Buffer.from(spec.prompt).toString("base64"))} | base64 -d)"`
		: "";
	return [
		`if [ -f ${sh(secretsDir)}/env ]; then set -a; . ${sh(secretsDir)}/env; set +a; fi`,
		`rm -rf ${sh(secretsDir)}`,
		`export ODIN_PORT=${REMOTE_ODIN_PORT}${spec.odinPane ? ` ODIN_PANE_ID=${sh(spec.odinPane)}` : ""}`,
		// git reads GH_TOKEN from the environment, never from a file or argv.
		`git config --global credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
		`mkdir -p ${root}`,
		spec.repoName && spec.cloneUrl
			? `[ -d ${repo}/.git ] || git clone ${sh(spec.cloneUrl)} ${repo} || echo "Odin: could not clone ${spec.cloneUrl.replaceAll('"', "")}"`
			: "",
		spec.repoName ? `git -C ${repo} fetch --quiet origin || true` : "",
		spec.repoName
			? `[ -d ${worktree} ] || git -C ${repo} worktree add -q -b ${sh(sessionBranch(spec.pane))} ${worktree} origin/HEAD 2>/dev/null || git -C ${repo} worktree add -q -b ${sh(sessionBranch(spec.pane))} ${worktree} 2>/dev/null || true`
			: "",
		spec.repoName ? `cd ${worktree} 2>/dev/null || cd ${repo}` : `cd ${repo}`,
		`python3 -c ${sh(SKIP_FIRST_RUN)} "$PWD" 2>/dev/null || true`,
		'export PATH="$HOME/.local/bin:$PATH"',
		ghInstallScript,
		`exec claude ${spec.claudeArgs}${prompt}`,
	]
		.filter(Boolean)
		.join("\n");
}

/** Reattach, or start the session in tmux. Runs as `bash -lc` in the terminal channel. */
export function attachScript(
	spec: RemoteSessionSpec,
	secretsDir: string,
): string {
	const session = sh(tmuxSession(spec.pane));
	const run = runScript(spec, secretsDir);
	return [
		`if tmux has-session -t ${session} 2>/dev/null; then rm -rf ${sh(secretsDir)}; exec tmux attach -t ${session}; fi`,
		`cat > ${sh(secretsDir)}/run.sh <<'ODIN_RUN'`,
		run,
		"ODIN_RUN",
		`exec tmux new-session -s ${session} "bash ${sh(secretsDir)}/run.sh"`,
	].join("\n");
}

/** Tokens waiting for their pane's helper: single use, two minutes. */
const tickets = new Map<string, { env: string; expires: number }>();

export function issueTicket(env: string, now = Date.now()): string {
	const ticket = crypto.randomUUID();
	tickets.set(ticket, { env, expires: now + 120_000 });
	return ticket;
}

export function redeemTicket(ticket: string, now = Date.now()): string | null {
	const entry = tickets.get(ticket);
	tickets.delete(ticket);
	return entry && entry.expires > now ? entry.env : null;
}

/** An origin URL as https, the form the host's token-based git helper reads. */
export function httpsCloneUrl(origin: string): string | null {
	const url = origin.trim();
	const scp = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
	if (scp) return `https://${scp[1]}/${scp[2]}`;
	return /^https:\/\//.test(url) ? url : null;
}

/** The token `claude setup-token` prints, out of its screen output. */
export function parseSetupToken(output: string): string | null {
	const text = stripAnsi(output);
	return text.match(/sk-ant-oat01-[\w-]+/g)?.pop() ?? null;
}

/**
 * Laptop files the prompt names (a screenshot, an attachment) don't exist on
 * the host. Each one that exists here is copied to ~/.odin/files there, and
 * the prompt names the copy instead.
 */
export function hostFiles(
	prompt: string,
	user: string,
	isFile: (path: string) => boolean,
): { prompt: string; files: RemoteFile[] } {
	const files: RemoteFile[] = [];
	const paths = new Set(
		prompt.match(/\/(?:Users|home|private|tmp|var)\/[^\s"'`)\]>]+/g),
	);
	let out = prompt;
	for (const local of paths) {
		const clean = local.replace(/[.,;:]+$/, "");
		if (!isFile(clean)) continue;
		const remote = `.odin/files/${files.length}-${clean.split("/").pop()}`;
		files.push({ local: clean, remote });
		out = out.replaceAll(clean, `${hostHome(user)}/${remote}`);
	}
	return { prompt: out, files };
}

/** What the agent on the host needs to know that its prompt assumes otherwise. */
export function hostNote(spec: {
	user: string;
	name: string;
	repoName: string | null;
	pane: string;
	/** Clone URLs of the repos Odin knows, for a task with no repo. */
	known?: string[];
}): string {
	const repos = `${hostHome(spec.user)}/repos`;
	return [
		"",
		`You run on ${spec.name}, a Linux server, not on my computer. Odin answers at http://127.0.0.1:$ODIN_PORT as usual, but its worktree action and its Shell work on my computer, so don't use them from here: make worktrees yourself, as below.`,
		spec.repoName
			? `Your worktree of ${spec.repoName} is the folder you start in, on branch ${sessionBranch(spec.pane)}. Push it and open the PR from here with gh. If that folder is not a git repository, clone the repo into ${repos} yourself.`
			: [
					`No repo was picked for this task: pick the one it is about. Clone it with git clone <url> ${repos}/<name> (skip that if it is already there), then git -C ${repos}/<name> worktree add -b ${sessionBranch(spec.pane)} ${repos}/<name>/.worktrees/${worktreeDir(spec.pane)} origin/HEAD, and work there.`,
					...(spec.known?.length
						? [
								"The repos on my computer:",
								...spec.known.map((url) => `- ${url}`),
							]
						: []),
				].join("\n"),
		"git and gh are signed in to GitHub with my account.",
	].join("\n");
}

/** A clone URL's repo name: https://github.com/o/odin.git -> odin. */
export const repoNameOf = (url: string) =>
	url
		.replace(/\/+$/, "")
		.split("/")
		.pop()
		?.replace(/\.git$/, "") || null;

/** The main checkout a session worktree path belongs to: <repo>/.worktrees/<name>. */
export const mainCheckoutOf = (path: string) =>
	path.replace(/\/\.worktrees\/[^/]+\/?$/, "");
