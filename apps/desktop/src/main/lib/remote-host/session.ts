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
}

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

/** What runs inside tmux: tokens in, file gone, repo ready, Claude on. */
export function runScript(spec: RemoteSessionSpec, secretsDir: string): string {
	const root = homePath(spec.reposRoot);
	const cwd = spec.repoName ? `${root}/${sh(spec.repoName)}` : root;
	const prompt = spec.prompt
		? ` "$(printf %s ${sh(Buffer.from(spec.prompt).toString("base64"))} | base64 -d)"`
		: "";
	return [
		`if [ -f ${sh(secretsDir)}/env ]; then set -a; . ${sh(secretsDir)}/env; set +a; fi`,
		`rm -rf ${sh(secretsDir)}`,
		// git reads GH_TOKEN from the environment, never from a file or argv.
		`git config --global credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`,
		`mkdir -p ${root}`,
		spec.repoName && spec.cloneUrl
			? `[ -d ${cwd}/.git ] || git clone ${sh(spec.cloneUrl)} ${cwd} || echo "Odin: could not clone ${spec.cloneUrl.replaceAll('"', "")}"`
			: "",
		spec.repoName ? `git -C ${cwd} fetch --quiet origin || true` : "",
		`cd ${cwd}`,
		`python3 -c ${sh(SKIP_FIRST_RUN)} "$PWD" 2>/dev/null || true`,
		'command -v claude >/dev/null || PATH="$HOME/.local/bin:$PATH"',
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
