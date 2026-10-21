import { tmuxSession } from "../../../shared/remote-reconnect";
import { HOST_PORT_SH } from "./host-service";

export { tmuxSession };

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
	/** End the session's tmux session first, so Claude starts over (Restart). */
	fresh?: boolean;
	/**
	 * The GitHub account the session signs in as (github-on-host). Its token
	 * is never in the session: git and gh ask the host service for the current
	 * one at each use, by this login.
	 */
	githubLogin?: string | null;
	/**
	 * A reconnect, set by the helper to when it started (ms): the prompt goes
	 * in only when the conversation has not taken it since then.
	 */
	since?: number;
}

/**
 * The spec a pane's helper reattaches with once its connection dropped. Claude
 * keeps working in tmux on the host meanwhile; if tmux is gone by then, the
 * conversation resumes instead of starting over. The prompt stays: the first
 * try may have ended before Claude took it (a reply that resumed a session
 * went missing this way), and the host drops it when the conversation
 * already holds it. Never fresh: that was the first try's job.
 */
export function reconnectSpec(
	spec: RemoteSessionSpec,
	startedAt: number,
): RemoteSessionSpec {
	return {
		...spec,
		claudeArgs: `--resume ${spec.pane}`,
		fresh: false,
		since: startedAt,
	};
}

export interface RemoteFile {
	local: string;
	/** Relative to the host user's home, where SFTP starts. */
	remote: string;
}

/**
 * This Odin user's Linux user on the host: odin- and their GitHub login (or
 * this computer's user name), so users sharing an instance never share a
 * home, a Claude sign-in or tokens.
 */
export const linuxUserName = (name: string) =>
	`odin-${
		name
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 27) || "user"
	}`;

/** The host user's home, for absolute paths Claude's file tools accept. */
export const hostHome = (user: string) =>
	user === "root" ? "/root" : `/home/${user}`;

/** The session's own worktree and branch, named after its conversation. */
export const sessionBranch = (pane: string) => `odin/${pane.slice(0, 8)}`;
export const worktreeDir = (pane: string) => `odin-${pane.slice(0, 8)}`;

/** Single-quote for a POSIX shell. */
export const sh = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** `~/x` as `"$HOME"/x`, so the shell expands it inside quotes too. */
export const homePath = (path: string) =>
	path === "~"
		? '"$HOME"'
		: path.startsWith("~/")
			? `"$HOME"/${sh(path.slice(2))}`
			: sh(path);

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
 * The GitHub CLI, so the agent can open PRs from the host. Downloaded into
 * the user's ~/.odin/bin when the host has no gh of its own, pinned by
 * SHA-256. What a session runs as `gh` is Odin's wrapper at ~/.local/bin/gh
 * (GITHUB_HELPERS_SCRIPT), which signs each call in with the current token.
 */
const GH_VERSION = "2.60.1";
const GH_SHA256: Record<string, string> = {
	amd64: "dfcd9926de38a797e88e604c3111ecf9ddf13c524706712b2b0d2e2fc4a6ed7f",
	arm64: "a2842ed6d1f9e260043305749383bb1eb77d817bb57e22cf8c01da0a48caff66",
};
export const ghInstallScript = [
	'if [ ! -x "$HOME/.odin/bin/gh" ] && ! type -aP gh 2>/dev/null | grep -qvx "$HOME/.local/bin/gh"; then',
	'  case "$(uname -m)" in aarch64|arm64) a=arm64;; *) a=amd64;; esac',
	`  [ "$a" = arm64 ] && sum=${GH_SHA256.arm64} || sum=${GH_SHA256.amd64}`,
	`  f=gh_${GH_VERSION}_linux_$a; t=$(mktemp -d)`,
	`  curl -fsSL -o "$t/gh.tgz" "https://github.com/cli/cli/releases/download/v${GH_VERSION}/$f.tar.gz" &&`,
	'  echo "$sum  $t/gh.tgz" | sha256sum -c --quiet &&',
	'  tar -xzf "$t/gh.tgz" -C "$t" && mkdir -p "$HOME/.odin/bin" && mv "$t/$f/bin/gh" "$HOME/.odin/bin/gh"',
	'  rm -rf "$t"',
	"fi",
].join("\n");

/**
 * How a session on the host signs in to GitHub: never with a token in its
 * environment, which is fixed at launch and dies eight hours later with the
 * work stranded on the host. git's credential helper and gh ask Odin's host
 * service for the current token at the moment of use (GET /token, loopback,
 * answered to this Linux user alone), and the service keeps it fresh:
 * the host's own sign-in refreshed there, or the laptop's latest copy.
 *
 * The helper tells the service the repo owner (useHttpPath), so a repo of
 * another account allowed on the host gets that account's token. `erase`
 * is git saying GitHub refused the token: the service then refreshes once.
 */
const SERVICE_TOKEN_URL =
	"http://127.0.0.1:$((40000 + $(id -u) % 10000 * 2))/token?service=github&login=$ODIN_GITHUB_LOGIN";
export const GIT_CREDENTIAL_HELPER = `#!/bin/sh
# Odin's git credential helper on a remote host: GitHub gets the token Odin's
# host service holds now, so a push never goes stale. See Odin's session.ts.
url="${SERVICE_TOKEN_URL}"
owner_of() { sed -n 's#^path=\\([^/]*\\)/.*#\\1#p' | head -1 | tr -cd 'A-Za-z0-9-'; }
case "$1" in
get)
  owner=$(owner_of)
  t=$(curl -sf -m 10 "$url&owner=$owner") && [ -n "$t" ] && printf 'username=x-access-token\\npassword=%s\\n' "$t"
  ;;
erase)
  in=$(cat)
  owner=$(printf %s "$in" | owner_of)
  printf %s "$in" | sed -n 's/^password=//p' | curl -sf -m 30 --data-binary @- "$url&owner=$owner" >/dev/null
  ;;
esac
exit 0
`;

/**
 * `gh` on the host: each call gets GH_TOKEN from the service, so gh never
 * answers "Bad credentials" after eight hours. Runs Odin's own gh, else the
 * next one on PATH. A session from before this wrapper keeps its old
 * GH_TOKEN when the service has none to give.
 */
export const GH_WRAPPER = `#!/bin/bash
# Odin's gh on a remote host: signed in with the token Odin's host service
# holds now, for the account of the repo here. See Odin's session.ts.
owner=$(git config --get remote.origin.url 2>/dev/null | sed -n 's#.*github\\.com[:/]\\([^/]*\\)/.*#\\1#p' | tr -cd 'A-Za-z0-9-')
t=$(curl -sf -m 10 "${SERVICE_TOKEN_URL}&owner=$owner") && [ -n "$t" ] && export GH_TOKEN="$t"
real="$HOME/.odin/bin/gh"
if [ ! -x "$real" ]; then
  for c in $(type -aP gh); do [ "$c" -ef "$0" ] || { real=$c; break; }; done
fi
[ -x "$real" ] || { echo "gh is not installed on this host." >&2; exit 127; }
exec "$real" "$@"
`;

const installFile = (path: string, content: string) =>
	`printf %s ${sh(Buffer.from(content).toString("base64"))} | base64 -d > ${path}.$$ && chmod 755 ${path}.$$ && mv -f ${path}.$$ ${path}`;

/**
 * Puts the helper and the wrapper on disk and names the helper in the user's
 * ~/.gitconfig. On disk, not in a session's environment, so a session already
 * running picks them up at its next git or gh call. A gh binary an older Odin
 * put at the wrapper's path moves aside first. Run under the setup lock:
 * ~/.gitconfig takes one writer at a time.
 */
export const GITHUB_HELPERS_SCRIPT = [
	'mkdir -p "$HOME/.odin/bin" "$HOME/.local/bin"',
	'if [ -f "$HOME/.local/bin/gh" ] && [ "$(head -c 2 "$HOME/.local/bin/gh")" != "#!" ]; then mv -f "$HOME/.local/bin/gh" "$HOME/.odin/bin/gh"; fi',
	installFile('"$HOME/.odin/bin/git-credential-odin"', GIT_CREDENTIAL_HELPER),
	installFile('"$HOME/.local/bin/gh"', GH_WRAPPER),
	'git config --global --replace-all credential.https://github.com.helper "!$HOME/.odin/bin/git-credential-odin" 2>/dev/null',
	"git config --global credential.https://github.com.useHttpPath true 2>/dev/null",
].join("\n");

/**
 * Claude's Stop and StopFailure hooks on the host. Every turn's end is marked
 * in ~/.odin/night/stopped/<session>, which is how the night runner knows
 * the last session stopped working. A turn that failed on a usage or spend
 * limit also flips the plan-limit switch, as claude-auto does on the laptop:
 * five hours in ~/.claude/plan-limit.json (a weekly limit just records
 * again), during which sessions start on the user's API key. A session on
 * the plan that has a key to fall back to is stopped and named in
 * ~/.odin/resume-<run script pid>, so the run script resumes it on the key.
 */
const TURN_END_HOOK = `import json, os, subprocess, sys, time
raw = sys.stdin.read()
try:
    session = json.loads(raw).get("session_id") or ""
except Exception:
    session = ""
stopped = os.path.expanduser("~/.odin/night/stopped")
os.makedirs(stopped, exist_ok=True)
if session and "/" not in session:
    open(os.path.join(stopped, session), "w").close()
if os.environ.get("ODIN_TURN") == "failed" and "limit" in raw.lower():
    # Written whole, then moved into place: the laptop's own plan-limit hook,
    # synced here, writes this file at the same moment, and two open-and-write
    # calls interleave into a file neither side can read afterwards.
    state = os.path.expanduser("~/.claude/plan-limit.json")
    with open(f"{state}.{os.getpid()}", "w") as f:
        json.dump({"until": time.time() + 5 * 3600}, f)
    os.replace(f"{state}.{os.getpid()}", state)
    run = os.environ.get("ODIN_RUN_PID", "")
    if run and session and os.environ.get("ODIN_HAS_FALLBACK_KEY") and not os.environ.get("ANTHROPIC_API_KEY"):
        pid = os.getppid()
        while pid > 1:
            parent = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[1]
            if parent == run:
                break
            pid = int(parent)
        if pid > 1:
            open(os.path.expanduser(f"~/.odin/resume-{run}"), "w").write(session)
            # Claude waits for this hook; stop it once the hook has returned.
            subprocess.Popen(["sh", "-c", f"sleep 2; kill {pid}"], start_new_session=True)`;

/**
 * Exits 0 when the conversation (argv[1]) stopped mid-turn: its last message
 * is a tool result, a prompt with no answer, or a reply cut off before its
 * end. A Resume with no prompt then says Continue, as a local one does for a
 * session that died working. An Esc ("[Request interrupted") is not cut off.
 */
export const CUT_OFF_TURN = `import glob, json, os, sys
paths = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{sys.argv[1]}.jsonl"))
last = None
for line in open(paths[0]) if paths else []:
    try:
        entry = json.loads(line)
    except Exception:
        continue
    if entry.get("type") in ("user", "assistant") and not entry.get("isMeta"):
        last = entry
if not last:
    sys.exit(1)
message = last.get("message") or {}
if last["type"] == "assistant":
    sys.exit(0 if message.get("stop_reason") in (None, "tool_use") else 1)
content = message.get("content")
text = content if isinstance(content, str) else " ".join(str(b.get("text", "")) for b in content or [] if isinstance(b, dict))
sys.exit(1 if "[Request interrupted" in text else 0)`;

/**
 * Exits 0 when the conversation (argv[1]) took the prompt (argv[2], base64)
 * since argv[3] (ms): as a turn of its own, or queued for after the one
 * running. A reconnect's attach asks before it puts the prompt in again. A
 * minute's slack covers the laptop's clock against the host's.
 */
export const PROMPT_TAKEN = `import base64, datetime, glob, json, os, sys
paths = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{sys.argv[1]}.jsonl"))
prompt = base64.b64decode(sys.argv[2]).decode().strip()
since = int(sys.argv[3]) - 60000
for line in open(paths[0]) if paths else []:
    try:
        entry = json.loads(line)
        at = datetime.datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        continue
    if at < since or entry.get("isMeta"):
        continue
    if entry.get("type") == "user":
        content = (entry.get("message") or {}).get("content")
    elif entry.get("type") == "queue-operation" and entry.get("operation") == "enqueue":
        content = entry.get("content")
    else:
        continue
    texts = [content] if isinstance(content, str) else [str(b.get("text", "")) for b in content or [] if isinstance(b, dict)]
    if prompt in (t.strip() for t in texts) or "\\n".join(texts).strip() == prompt:
        sys.exit(0)
sys.exit(1)`;

/** On the API key while the plan is limited, with the key pre-approved. */
const USE_API_KEY_IF_LIMITED = `import json, os, sys, time
try:
    limited = json.load(open(os.path.expanduser("~/.claude/plan-limit.json"))).get("until", 0) > time.time()
except Exception:
    limited = False
if not limited:
    sys.exit(1)
p = os.path.expanduser("~/.claude.json")
try:
    c = json.load(open(p))
except Exception:
    c = {}
r = c.setdefault("customApiKeyResponses", {"approved": [], "rejected": []})
k = os.environ["ODIN_FALLBACK_API_KEY"][-20:]
if k not in r.setdefault("approved", []):
    r["approved"].append(k)
json.dump(c, open(p, "w"), indent=2)`;

/**
 * Odin's status hook, as on the laptop: it tells the card the session is
 * Working, needs you, or is done, through the host's ODIN_PORT. The laptop's
 * notify.sh goes over with the session's files (HOST_NOTIFY_HOOK). The
 * laptop's own entries in a synced settings.json need ODIN_HOME_DIR, unset
 * here, so they stay quiet and nothing reports twice.
 */
export const HOST_NOTIFY_HOOK = ".odin/notify.sh";
const notify = (matcher?: string) => ({
	...(matcher ? { matcher } : {}),
	hooks: [
		{
			type: "command",
			command:
				'[ ! -f "$HOME/.odin/notify.sh" ] || ODIN_AGENT_ID=claude bash "$HOME/.odin/notify.sh"',
		},
	],
});

export const hostSettings = JSON.stringify({
	hooks: {
		UserPromptSubmit: [notify()],
		Stop: [
			{ hooks: [{ type: "command", command: "python3 ~/.odin/turn-end.py" }] },
			notify(),
		],
		StopFailure: [
			{
				hooks: [
					{
						type: "command",
						command: "ODIN_TURN=failed python3 ~/.odin/turn-end.py",
					},
				],
			},
			notify(),
		],
		PostToolUse: [notify("*")],
		PostToolUseFailure: [notify("*")],
		PreToolUse: [notify("AskUserQuestion|ExitPlanMode")],
		PreCompact: [notify()],
		SessionEnd: [notify()],
	},
});

/**
 * The host's own Claude sign-in. A new one from the laptop (ODIN_CLAUDE_LOGIN_ID
 * not seen before) signs Claude in with its refresh token once; after that the
 * host refreshes its own. A host signed in that way drops the inference-only
 * setup token, which hides extra usage at a usage limit.
 */
export const CLAUDE_LOGIN_SCRIPT = [
	'if [ -n "$ODIN_CLAUDE_REFRESH_TOKEN" ] && [ "$(cat "$HOME/.odin/claude-login-id" 2>/dev/null)" != "$ODIN_CLAUDE_LOGIN_ID" ]; then',
	'  CLAUDE_CODE_OAUTH_REFRESH_TOKEN="$ODIN_CLAUDE_REFRESH_TOKEN" CLAUDE_CODE_OAUTH_SCOPES="$ODIN_CLAUDE_SCOPES" env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY claude auth login >/dev/null 2>&1 &&',
	'  mkdir -p "$HOME/.odin" && printf %s "$ODIN_CLAUDE_LOGIN_ID" > "$HOME/.odin/claude-login-id"',
	"fi",
	"unset ODIN_CLAUDE_REFRESH_TOKEN ODIN_CLAUDE_SCOPES ODIN_CLAUDE_LOGIN_ID",
	'[ -s "$HOME/.odin/claude-login-id" ] && unset CLAUDE_CODE_OAUTH_TOKEN',
].join("\n");

/**
 * The run script starts over inside its own user scope, capped at this
 * percent of the host's RAM with no swap. A runaway build (12 GB of bun) then
 * meets the kernel's out-of-memory killer inside this session only, which
 * stops its biggest process, instead of freezing every session on the host. It needs no
 * setup: the user's systemd manager does it, as on Ubuntu 24.04. Where that
 * fails (no user manager, another distro) the script runs without a cap.
 */
const SESSION_MEMORY_PERCENT = 50;
export const MEMORY_LIMIT_SCRIPT = [
	'if [ -z "$ODIN_MEMORY_SCOPE" ]; then',
	"  export ODIN_MEMORY_SCOPE=1",
	'  [ -n "$XDG_RUNTIME_DIR" ] || XDG_RUNTIME_DIR=/run/user/$(id -u); export XDG_RUNTIME_DIR',
	'  [ -n "$DBUS_SESSION_BUS_ADDRESS" ] || [ ! -S "$XDG_RUNTIME_DIR/bus" ] || export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"',
	`  max=$(awk '/^MemTotal:/ { printf "%dK", $2 * ${SESSION_MEMORY_PERCENT} / 100 }' /proc/meminfo 2>/dev/null)`,
	'  limit="systemd-run --user --scope --quiet -p MemoryMax=$max -p MemorySwapMax=0"',
	'  if [ -n "$max" ] && $limit true >/dev/null 2>&1; then exec $limit bash "$0"; fi',
	"fi",
].join("\n");

/** What runs inside tmux: tokens in, file gone, repo ready, Claude on. */
export function runScript(spec: RemoteSessionSpec, secretsDir: string): string {
	const root = homePath(spec.reposRoot);
	const repo = spec.repoName ? `${root}/${sh(spec.repoName)}` : root;
	// Every session gets its own worktree, so two on one repo never collide;
	// a resume finds the same one by name, or, after Done removed it, gets it
	// back from its branch, which Done keeps.
	const worktree = `${repo}/.worktrees/${sh(worktreeDir(spec.pane))}`;
	// The prompt as Claude's last argument, in an array so a session with
	// nothing to say gets no argument at all. A reconnect's attach puts it in
	// only when the conversation has not taken it. A Resume with nothing to
	// say picks a cut-off turn back up.
	const resumed = spec.claudeArgs.match(/--resume (\S+)/)?.[1];
	const prompt = spec.prompt ? promptIn(spec) : "";
	const promptLines = [
		"p=()",
		prompt && spec.since
			? `${promptTaken(spec)} || p=(${prompt})`
			: prompt
				? `p=(${prompt})`
				: "",
		resumed
			? `[ "\${#p[@]}" -eq 0 ] && python3 -c ${sh(CUT_OFF_TURN)} ${sh(resumed)} 2>/dev/null && p=(Continue)`
			: "",
	];
	return [
		MEMORY_LIMIT_SCRIPT,
		`if [ -f ${sh(secretsDir)}/env ]; then set -a; . ${sh(secretsDir)}/env; set +a; fi`,
		`rm -rf ${sh(secretsDir)}`,
		// Sessions starting together take turns at setup: clone, fetch and
		// worktree add on one repo, the Claude login and turn-end.py all
		// break when two runs write them at once. Waits 2 min at most.
		// One lock per host: sessions on different repos wait for each other too.
		'mkdir -p "$HOME/.odin" && exec 9>"$HOME/.odin/setup.lock" && flock -w 120 9 2>/dev/null',
		// Odin's host service when setup installed it (connector calls answered
		// there, the rest passed on); else the helper's tunnel to the laptop.
		// Both ports are this Linux user's own (hostPorts).
		`p=${HOST_PORT_SH}; curl -sf -m 2 http://127.0.0.1:$p/health >/dev/null && ODIN_PORT=$p || ODIN_PORT=$((p + 1))`,
		`export ODIN_PORT${spec.odinPane ? ` ODIN_PANE_ID=${sh(spec.odinPane)}` : ""}`,
		// GitHub: the account's login, not its token. git and gh get the
		// current token from the host service at each use (GITHUB_HELPERS_SCRIPT).
		spec.githubLogin ? `export ODIN_GITHUB_LOGIN=${sh(spec.githubLogin)}` : "",
		GITHUB_HELPERS_SCRIPT,
		`mkdir -p ${root}`,
		spec.repoName && spec.cloneUrl
			? `[ -d ${repo}/.git ] || git clone ${sh(spec.cloneUrl)} ${repo} || echo "Odin: could not clone ${spec.cloneUrl.replaceAll('"', "")}"`
			: "",
		spec.repoName ? `git -C ${repo} fetch --quiet origin || true` : "",
		spec.repoName
			? `[ -d ${worktree} ] || git -C ${repo} worktree add -q -b ${sh(sessionBranch(spec.pane))} ${worktree} origin/HEAD 2>/dev/null || git -C ${repo} worktree add -q -b ${sh(sessionBranch(spec.pane))} ${worktree} 2>/dev/null || git -C ${repo} worktree add -q ${worktree} ${sh(sessionBranch(spec.pane))} 2>/dev/null || true`
			: "",
		spec.repoName ? `cd ${worktree} 2>/dev/null || cd ${repo}` : `cd ${repo}`,
		`python3 -c ${sh(SKIP_FIRST_RUN)} "$PWD" 2>/dev/null || true`,
		'export PATH="$HOME/.local/bin:$PATH"',
		CLAUDE_LOGIN_SCRIPT,
		ghInstallScript,
		`mkdir -p "$HOME/.odin" && printf %s ${sh(Buffer.from(TURN_END_HOOK).toString("base64"))} | base64 -d > "$HOME/.odin/turn-end.py.$$" && mv -f "$HOME/.odin/turn-end.py.$$" "$HOME/.odin/turn-end.py"`,
		// Claude must not hold the lock, or no other session starts until it exits.
		"exec 9>&-",
		`if [ -n "$ODIN_FALLBACK_API_KEY" ] && python3 -c ${sh(USE_API_KEY_IF_LIMITED)}; then export ANTHROPIC_API_KEY="$ODIN_FALLBACK_API_KEY"; else unset ANTHROPIC_API_KEY; fi`,
		// Kept unexported, for resuming on the key when the plan runs out mid-session.
		'fallback="$ODIN_FALLBACK_API_KEY"',
		"unset ODIN_FALLBACK_API_KEY",
		'export ODIN_RUN_PID=$$; [ -n "$fallback" ] && export ODIN_HAS_FALLBACK_KEY=1',
		...promptLines,
		`claude --settings ${sh(hostSettings)} ${spec.claudeArgs} "\${p[@]}"`,
		`if [ -s "$HOME/.odin/resume-$$" ]; then s=$(cat "$HOME/.odin/resume-$$"); rm -f "$HOME/.odin/resume-$$"; ODIN_FALLBACK_API_KEY="$fallback" python3 -c ${sh(USE_API_KEY_IF_LIMITED)}; ANTHROPIC_API_KEY="$fallback" exec claude --settings ${sh(hostSettings)} --resume "$s" "Continue where you left off."; fi`,
	]
		.filter(Boolean)
		.join("\n");
}

/** The prompt, base64 so no quoting can break it, decoded in the shell. */
const promptB64 = (spec: RemoteSessionSpec) =>
	sh(Buffer.from(spec.prompt ?? "").toString("base64"));
const promptIn = (spec: RemoteSessionSpec) =>
	`"$(printf %s ${promptB64(spec)} | base64 -d)"`;
/** Exits 0 when the conversation took the prompt since the reconnect began. */
const promptTaken = (spec: RemoteSessionSpec) =>
	`python3 -c ${sh(PROMPT_TAKEN)} ${sh(spec.pane)} ${promptB64(spec)} ${sh(String(spec.since ?? 0))} 2>/dev/null`;

/** Reattach, or start the session in tmux. Runs as `bash -lc` in the terminal channel. */
export function attachScript(
	spec: RemoteSessionSpec,
	secretsDir: string,
): string {
	const session = sh(tmuxSession(spec.pane));
	const run = runScript(spec, secretsDir);
	// A reply that resumes a session still up in tmux: pasted into its Claude,
	// which the run script's prompt never reaches. Behind the attach, once
	// Claude is the pane's command: while the run script still sets up, keys
	// land in its pty and come out in Claude as a second copy of the prompt
	// the script hands it. A reconnect pastes only what Claude never took.
	const paste = `printf %s ${promptB64(spec)} | base64 -d | tmux load-buffer -b odin-reply-$$ - && tmux paste-buffer -p -d -b odin-reply-$$ -t ${session} && sleep 0.5 && tmux send-keys -t ${session} Enter`;
	const reply =
		spec.prompt && /--resume\b/.test(spec.claudeArgs)
			? `( for _ in $(seq 1 120); do [ "$(tmux display -p -t ${session} '#{pane_current_command}' 2>/dev/null)" = claude ] && break; sleep 1; done; sleep 2; ${spec.since ? `${promptTaken(spec)} || ` : ""}{ ${paste}; }; ) >/dev/null 2>&1 & `
			: "";
	return [
		// tmux sizes a window to one attached client. Its default, `latest`, is
		// whichever client attached most recently - and a dropped connection,
		// a remounted pane or a Resume leaves the previous SSH client attached
		// at the spawn default (80x24), so that stale client, not the live
		// viewer, pins Claude's TUI to 80 columns the moment it becomes the
		// latest. `largest` sizes the window to the biggest attached client, so
		// the real wide viewer wins over a leftover 80x24 one.
		"tmux set-option -g window-size largest 2>/dev/null",
		spec.fresh ? `tmux kill-session -t ${session} 2>/dev/null` : "",
		`if tmux has-session -t ${session} 2>/dev/null; then rm -rf ${sh(secretsDir)}; ${reply}exec tmux attach -t ${session}; fi`,
		`cat > ${sh(secretsDir)}/run.sh <<'ODIN_RUN'`,
		run,
		"ODIN_RUN",
		`exec tmux new-session -s ${session} "bash ${sh(secretsDir)}/run.sh"`,
	]
		.filter(Boolean)
		.join("\n");
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

/** A Claude sign-in for the host; `id` tells the host a new one arrived. */
export interface ClaudeLogin {
	refreshToken: string;
	scopes: string;
	id: string;
}

/** The sign-in out of Claude's saved credentials JSON, or null. */
export function parseClaudeLogin(
	saved: string,
	id: string,
): ClaudeLogin | null {
	try {
		const oauth = JSON.parse(saved).claudeAiOauth;
		if (typeof oauth?.refreshToken !== "string") return null;
		return {
			refreshToken: oauth.refreshToken,
			scopes: (oauth.scopes ?? []).join(" "),
			id,
		};
	} catch {
		return null;
	}
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
	prefix = "",
): { prompt: string; files: RemoteFile[] } {
	const files: RemoteFile[] = [];
	const paths = new Set(
		prompt.match(/\/(?:Users|home|private|tmp|var)\/[^\s"'`)\]>]+/g),
	);
	let out = prompt;
	for (const local of paths) {
		const clean = local.replace(/[.,;:]+$/, "");
		if (!isFile(clean)) continue;
		const remote = `.odin/files/${prefix}${files.length}-${clean.split("/").pop()}`;
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
