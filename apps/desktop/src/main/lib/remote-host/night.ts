/**
 * The Night Agent on the remote host, so it runs with the laptop closed.
 *
 * While the laptop is awake, Odin ranks tonight's tasks as it always has and
 * sends the host a plan: the window as absolute times, the cap, and each task
 * as a ready-to-run session script. A runner on the host (a systemd timer,
 * every minute, as the user's own Linux user) starts them one at a time in tmux, each
 * once the last one's turn ended (the turn-end hook's marker), and only while
 * the host has room for one more (the rule the laptop applies before a launch
 * there, in launch-gate.ts). When the laptop wakes, Odin reads what the host
 * started and puts those sessions on the board.
 *
 * So a laptop closed for days still has nights: a plan covers the next few
 * windows (`nights`), the runner keeps each night's starts apart, and every
 * start goes in an append-only ledger (ran.jsonl) first, so no key ever runs
 * twice. When the laptop's queue runs out, the host fills the night itself,
 * once: it lists the Slack messages you marked :eyes: through its own service,
 * a read-only Claude only orders them, and each runs from a template the
 * laptop sent (`fallback`). A plan stops at `until`, so a host you switched
 * away from goes quiet on its own.
 */
import { MIN_HOST_FREE_MEMORY_SHARE } from "shared/launch-gate";
import { sh } from "./session";
import { adminLogin, connectHost, type HostLogin, runOnHost } from "./ssh";

/** The placeholder a task's run script names its secrets dir by. */
export const SECRETS_DIR_PLACEHOLDER = "__ODIN_SECRETS_DIR__";
/** The fallback template's session id; the runner puts a fresh one in its place. */
export const NIGHT_PANE_PLACEHOLDER = "0dinpane-0000-4000-8000-000000000000";
/** Where the fallback template's prompt, base64, goes in its script. */
export const NIGHT_PROMPT_B64_PLACEHOLDER = "__ODIN_PROMPT_B64__";
/** Where a picked message goes in the fallback template's prompt. */
export const NIGHT_TASK_PLACEHOLDER = "__ODIN_NIGHT_TASK__";

export interface NightTask {
	key: string;
	title: string;
	sessionId: string;
	/** runScript() output with the secrets dir as SECRETS_DIR_PLACEHOLDER. */
	script: string;
}

/** What the host needs to fill a night with no laptop: a session template and the ranking words. */
export interface NightFallback {
	/** runScript() of a no-repo session, its id NIGHT_PANE_PLACEHOLDER and its prompt NIGHT_PROMPT_B64_PLACEHOLDER. */
	script: string;
	/** That session's prompt, with NIGHT_TASK_PLACEHOLDER where the message goes. */
	prompt: string;
	/** Your sort words and the Night Agent ones, which the ranking obeys. */
	rank: string;
}

export interface NightPlan {
	/** Changes with every plan, so the host knows a new night from a resend. */
	id: string;
	/** The window, as epoch seconds - the host's clock and timezone don't matter. */
	from: number;
	to: number;
	cap: number;
	tasks: NightTask[];
	/** Tonight's window and the next ones, as this computer's clock puts them (so a clock change is right). */
	nights?: { from: number; to: number }[];
	/** Epoch seconds the plan stops at, so a host this computer stopped sending to goes quiet. */
	until?: number;
	/** Keys that never start: done, dismissed, started on any host. */
	exclude?: string[];
	fallback?: NightFallback;
}

/** A window that opened on the host with no plan for it, epoch seconds. */
export interface NightMissed {
	night: number;
	at: number;
}

export interface NightStarted {
	key: string;
	title: string;
	sessionId: string;
	at: number;
	/** The message's link, for a row the host picked itself. */
	url?: string;
	/** true: the host picked it, with no row of the laptop's behind it. */
	picked?: boolean;
}

export const NIGHT_RUNNER_PY = `import base64, json, os, re, shutil, subprocess, tempfile, time, urllib.parse, urllib.request, uuid

HOME = os.path.expanduser("~/.odin/night")
PLAN, STATE = HOME + "/plan.json", HOME + "/state.json"
MISSED, LEDGER = HOME + "/missed.json", HOME + "/ran.jsonl"
DAY = 86400
PANE = "${NIGHT_PANE_PLACEHOLDER}"
PROMPT_B64 = "${NIGHT_PROMPT_B64_PLACEHOLDER}"
TASK = "${NIGHT_TASK_PLACEHOLDER}"
# Only these become a session the host picked itself: a Slack message's key.
PICKED_KEY = re.compile(r"^slack:[CDG][A-Z0-9]+:[0-9]+[.][0-9]+$")
# A message marked longer ago than this is left for the laptop's own list.
PICK_DAYS = 14
# The share of its memory this host must have free before one more session
# starts here: the same share the laptop waits for before a launch to it.
MIN_FREE_SHARE = ${MIN_HOST_FREE_MEMORY_SHARE}


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def kb(meminfo, field):
    for line in meminfo.splitlines():
        if line.startswith(field + ":"):
            try:
                return int(line.split()[1])
            except (IndexError, ValueError):
                return None
    return None


def hold_reason(meminfo, loadavg, cores):
    """Why this host can't take a session now, or None. Numbers that can't be read don't hold it."""
    total, free = kb(meminfo, "MemTotal"), kb(meminfo, "MemAvailable")
    if total and free is not None and free < total * MIN_FREE_SHARE:
        return "has %.1f GB free" % (free / 1048576)
    try:
        load1 = float(loadavg.split()[0])
    except (IndexError, ValueError):
        return None
    if cores and load1 > cores:
        return "is busy (load %.1f on %d cores)" % (load1, cores)
    return None


def session_name(session):
    return "odin-" + "".join(c if c.isalnum() or c in "_-" else "-" for c in session)[:60]


def alive(session):
    return subprocess.run(["tmux", "has-session", "-t", session_name(session)], capture_output=True).returncode == 0


def missed_night(plan, now):
    """The start of the window open now when the plan is for an earlier night, or None.

    The window repeats daily, so last night's plan says when tonight's opens."""
    days = int((now - plan["from"]) // DAY)
    if days < 1:
        return None
    start = plan["from"] + days * DAY
    return start if now < plan["to"] + days * DAY else None


def note_missed(plan, now):
    """Records a window that opened with no plan for it, once, so the laptop can say why nothing ran."""
    night = missed_night(plan, now)
    if night is None:
        return
    missed = load(MISSED, [])
    if any(m.get("night") == night for m in missed):
        return
    print("the window opened with no plan for tonight: the last plan is for an earlier night")
    missed = (missed + [{"night": night, "at": now}])[-14:]
    with open(MISSED + ".new", "w") as f:
        json.dump(missed, f)
    os.replace(MISSED + ".new", MISSED)


def save(path, data):
    with open(path + ".new", "w") as f:
        json.dump(data, f)
    os.replace(path + ".new", path)


def nights_of(plan):
    return plan.get("nights") or [{"from": plan["from"], "to": plan["to"]}]


def night_now(plan, now):
    """The plan's window open now, or None."""
    return next((n for n in nights_of(plan) if n["from"] <= now < n["to"]), None)


def ledger():
    """Every start, across nights and plans. A torn last line (a crash mid-write) is skipped."""
    rows = []
    try:
        with open(LEDGER) as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return rows


def record(row):
    """Appends a start to the ledger, on disk before the session starts."""
    os.makedirs(HOME, exist_ok=True)
    with open(LEDGER, "ab+") as f:
        # A line torn by a crash gets its own line ended, so this row stays whole.
        f.seek(0, os.SEEK_END)
        if f.tell():
            f.seek(-1, os.SEEK_END)
            if f.read(1) != b"\\n":
                f.write(b"\\n")
        f.write(json.dumps(row).encode() + b"\\n")
        f.flush()
        os.fsync(f.fileno())


def night_state(state, plan, night):
    """This night's starts, kept apart from other nights' so a plan rolls over to the next."""
    if "started" in state:
        # Kept by a runner from before nights had their own state.
        state = {"nights": {str(int(state.get("night") or 0)): {"started": state["started"]}}}
    nights = state.setdefault("nights", {})
    for key in sorted(nights, key=float)[:-14]:
        del nights[key]
    state["plan"] = plan["id"]
    return state, nights.setdefault(str(int(night["from"])), {"started": []})


def service(path):
    """A Slack API call through this user's own Odin service on the host, which holds the token."""
    port = 40000 + (os.getuid() % 10000) * 2
    body = urllib.parse.urlencode({"action": "service", "service": "slack", "path": path}).encode()
    raw = urllib.request.urlopen("http://127.0.0.1:%d/odin" % port, body, timeout=30).read().decode("utf-8", "replace")
    return json.loads(raw[raw.find("{"):])


def marked(now):
    """The Slack messages you marked :eyes: lately, as the board keys them."""
    got = service("reactions.list?limit=100&full=true")
    if not got.get("ok"):
        raise RuntimeError("Slack said %s" % got.get("error"))
    out = []
    for item in got.get("items", []):
        m = item.get("message") or {}
        if item.get("type") != "message" or not any(r.get("name") == "eyes" for r in m.get("reactions", [])):
            continue
        if now - float(m.get("ts") or 0) > PICK_DAYS * DAY:
            continue
        out.append({"key": "slack:%s:%s" % (item.get("channel"), m.get("ts")),
                    "title": " ".join((m.get("text") or "").split())[:120] or "A Slack message",
                    "url": m.get("permalink") or ""})
    return out


def claude():
    for path in (os.path.expanduser("~/.local/bin/claude"), shutil.which("claude")):
        if path and os.path.exists(path):
            return path
    return None


def rank(cands, words):
    """The candidates' keys in the order a read-only Claude puts them; None when it can't."""
    exe = claude()
    if not exe or not cands:
        return None
    prompt = (json.dumps(cands) + chr(10) * 2 +
              "These Slack messages wait for me. Order them for an agent that works on them one by one tonight while I'm away: "
              "most actionable and urgent first, and leave out any that look already handled (you may read their threads). "
              "Answer with only a JSON array of keys, each taken from the list." +
              (chr(10) * 2 + "My instructions for the ranking:" + chr(10) + words if words else ""))
    # Read-only: no shell, no files, and every tool not named here is refused, not asked about.
    out = subprocess.run([exe, "-p", "--output-format", "json", "--permission-mode", "dontAsk", "--tools", "ToolSearch",
                          "--allowedTools", "mcp__claude_ai_Slack__slack_read_thread"],
                         input=prompt, capture_output=True, text=True, timeout=900,
                         env={"HOME": os.path.expanduser("~"), "USER": os.environ.get("USER", ""), "PATH": "/usr/bin:/bin"})
    found = re.search(r"[[].*[]]", json.loads(out.stdout).get("result") or "", re.S)
    return json.loads(found.group(0)) if found else None


def picked_tasks(plan, skip, now):
    """The night's own picks when the laptop's queue ran out: listed here, ordered by Claude, never anything else."""
    fb = plan.get("fallback")
    if not fb:
        return []
    cands = [c for c in marked(now) if PICKED_KEY.match(c["key"]) and c["key"] not in skip]
    by_key = {c["key"]: c for c in cands}
    order = list(by_key)
    try:
        ranked = [k for k in (rank(cands, fb.get("rank") or "") or []) if k in by_key]
        order = list(dict.fromkeys(ranked)) + [k for k in order if k not in ranked]
    except Exception as e:
        print("ranking failed, so the list's own order: %s" % e)
    tasks = []
    for key in order:
        c, sid = by_key[key], str(uuid.uuid4())
        text = c["title"] + chr(10) * 2 + c["url"] + chr(10) * 2 + (
            "A Slack message I marked :eyes:, which the Night Agent on the host picked while my computer was away. "
            "Read its thread with Odin's Slack connection, then do what it asks of me. If it is already handled, stop.")
        prompt = fb["prompt"].replace(TASK, text).replace(PANE, sid).replace(PANE[:8], sid[:8])
        script = (fb["script"].replace(PROMPT_B64, base64.b64encode(prompt.encode()).decode())
                  .replace(PANE, sid).replace(PANE[:8], sid[:8]))
        tasks.append({"key": key, "title": c["title"], "url": c["url"], "sessionId": sid, "script": script, "picked": True})
    return tasks


def main():
    plan = load(PLAN, None)
    now = time.time()
    if not plan or now >= plan.get("until", float("inf")):
        return
    night = night_now(plan, now)
    if not night:
        if now >= max(n["to"] for n in nights_of(plan)):
            note_missed(plan, now)
        return
    state, tonight = night_state(load(STATE, {}), plan, night)
    started = tonight["started"]
    if len(started) >= plan["cap"]:
        return
    if started:
        last = started[-1]["sessionId"]
        if alive(last) and not os.path.exists(HOME + "/stopped/" + last):
            return
    skip = {r.get("key") for r in ledger()} | set(plan.get("exclude") or []) | {s["key"] for s in started}
    task = next((t for t in plan["tasks"] if t["key"] not in skip), None)
    if not task:
        if "picked" not in tonight:
            # Once a night: a failed list is tried again next minute, a failed ranking is not.
            try:
                tonight["picked"] = picked_tasks(plan, skip, now)
            except Exception as e:
                print("couldn't list tonight's own picks: %s" % e)
                return
            save(STATE, state)
            if tonight["picked"]:
                print("the laptop's queue is done: picked %d marked Slack messages here" % len(tonight["picked"]))
        task = next((t for t in tonight["picked"] if t["key"] not in skip), None)
    if not task:
        return
    # The sessions already on this host (panes that keep working while the
    # laptop is away, the last task) share its memory with this one. One more
    # while it is short has frozen the host and every session on it; the
    # timer brings the runner back in a minute to look again.
    reason = hold_reason(read("/proc/meminfo"), read("/proc/loadavg"), os.cpu_count())
    if reason:
        print("holding " + task["title"] + ": this host " + reason)
        return
    secrets = tempfile.mkdtemp(prefix="odin.", dir="/dev/shm")
    shutil.copyfile(HOME + "/env", secrets + "/env")
    os.chmod(secrets + "/env", 0o600)
    with open(secrets + "/run.sh", "w") as f:
        f.write(task["script"].replace("${SECRETS_DIR_PLACEHOLDER}", secrets))
    row = {"key": task["key"], "title": task["title"], "sessionId": task["sessionId"], "at": now, "night": night["from"]}
    if task.get("picked"):
        row.update({"url": task.get("url", ""), "picked": True})
    # In the ledger before the start: a crash between the two never starts it twice.
    record(row)
    started.append(row)
    save(STATE, state)
    subprocess.run(["tmux", "new-session", "-d", "-s", session_name(task["sessionId"]), "bash " + secrets + "/run.sh"], check=True)


if __name__ == "__main__":
    main()
`;

/** A host user's runner unit, without .service or .timer. */
const nightUnit = (user: string) => `/etc/systemd/system/odin-night-${user}`;

/**
 * Root's part: a host user's runner and its timer, as that user. KillMode=process
 * keeps the tmux server it starts alive after the run ends. Replaces the one
 * runner from when users shared a login, when it ran as this user.
 */
export function nightInstallScript(user: string): string {
	const unit = [
		"[Unit]",
		"Description=Odin Night Agent runner",
		"[Service]",
		"Type=oneshot",
		`User=${user}`,
		"KillMode=process",
		"ExecStart=/usr/bin/python3 /usr/local/lib/odin/night-runner.py",
	];
	const timer = [
		"[Unit]",
		"Description=Odin Night Agent, every minute",
		"[Timer]",
		"OnBootSec=60",
		"OnUnitActiveSec=60",
		"AccuracySec=5",
		"[Install]",
		"WantedBy=timers.target",
	];
	return [
		"command -v systemctl >/dev/null || exit 0",
		`if grep -qx ${sh(`User=${user}`)} /etc/systemd/system/odin-night.service 2>/dev/null; then systemctl disable --now odin-night.timer >/dev/null 2>&1; rm -f /etc/systemd/system/odin-night.service /etc/systemd/system/odin-night.timer; fi`,
		"install -d -m 755 /usr/local/lib/odin",
		`printf %s '${Buffer.from(NIGHT_RUNNER_PY).toString("base64")}' | base64 -d > /usr/local/lib/odin/night-runner.py`,
		`printf '%s\\n' ${unit.map(sh).join(" ")} > ${nightUnit(user)}.service`,
		`printf '%s\\n' ${timer.map(sh).join(" ")} > ${nightUnit(user)}.timer`,
		`systemctl daemon-reload && systemctl enable --now odin-night-${user}.timer >/dev/null 2>&1`,
	].join("\n");
}

/**
 * Sends tonight's plan and the secrets its sessions start with. Installs the
 * runner when the host has none. Plan and secrets are the login user's files,
 * mode 0600, written over SSH stdin.
 */
export async function pushNightPlan(
	host: HostLogin,
	plan: NightPlan,
	secrets: string,
	files: { local: string; remote: string }[],
): Promise<void> {
	const client = await connectHost(host);
	try {
		const installed = await runOnHost(
			client,
			`[ -f ${nightUnit(host.user)}.timer ] && cmp -s /usr/local/lib/odin/night-runner.py - && echo yes; true`,
			NIGHT_RUNNER_PY,
		);
		if (installed !== "yes") {
			// Root's work, which only an administrator's AWS sign-in may do.
			try {
				const admin = await connectHost(adminLogin(host));
				await runOnHost(
					admin,
					`sudo -n bash -c ${sh(nightInstallScript(host.user))}`,
				).finally(() => admin.end());
			} catch (error) {
				throw new Error(
					`The night runner isn't installed on the host for ${host.user}, and installing it needs ssm:SendCommand on the host. Your AWS role needs the permissions in docs/remote-host.md (Who can use a host); ask an administrator to add them. (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		}
		const write = (path: string) =>
			`umask 077; mkdir -p ~/.odin/night/stopped && cat > ~/.odin/night/${path}.new && mv ~/.odin/night/${path}.new ~/.odin/night/${path}`;
		await runOnHost(client, write("env"), secrets);
		if (files.length) {
			await runOnHost(client, "mkdir -p ~/.odin/files");
			const sftp = await new Promise<import("ssh2").SFTPWrapper>(
				(resolve, reject) =>
					client.sftp((err, s) => (err ? reject(err) : resolve(s))),
			);
			for (const file of files)
				await new Promise<void>((resolve) =>
					sftp.fastPut(file.local, file.remote, () => resolve()),
				);
		}
		await runOnHost(client, write("plan.json"), JSON.stringify(plan));
	} finally {
		client.end();
	}
}

/**
 * What the host's runner started for the current plan, oldest first; which
 * night its plan is for; and the windows that opened there with no plan.
 */
export async function readNightStarted(host: HostLogin): Promise<{
	started: NightStarted[];
	planFrom: number | null;
	missed: NightMissed[];
}> {
	const client = await connectHost(host);
	try {
		const raw = await runOnHost(client, `python3 -c ${sh(READ_NIGHT_PY)}`);
		return parseNightRead(raw);
	} finally {
		client.end();
	}
}

/** Prints the runner's state, its plan's night and its missed windows as one JSON line. */
export const READ_NIGHT_PY = `import json, os
home = os.path.expanduser("~/.odin/night")
def load(name, default):
    try:
        with open(home + "/" + name) as f:
            return json.load(f)
    except Exception:
        return default
def ran():
    rows = []
    try:
        with open(home + "/ran.jsonl") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        state = load("state.json", {})
        rows = state.get("started") or [r for n in state.get("nights", {}).values() for r in n.get("started", [])]
    return rows[-200:]
plan = load("plan.json", None)
print(json.dumps({"started": ran(), "planFrom": plan.get("from") if isinstance(plan, dict) else None, "missed": load("missed.json", [])}))
`;

/** Stops a host's nights: the plan goes, the ledger stays. For a host this computer no longer sends plans to. */
export async function clearNightPlan(host: HostLogin): Promise<void> {
	const client = await connectHost(host);
	try {
		await runOnHost(client, "rm -f ~/.odin/night/plan.json");
	} finally {
		client.end();
	}
}

export function parseNightRead(raw: string): {
	started: NightStarted[];
	planFrom: number | null;
	missed: NightMissed[];
} {
	const read = JSON.parse(raw || "{}") as {
		started?: NightStarted[];
		planFrom?: number | null;
		missed?: NightMissed[];
	};
	return {
		started: read.started ?? [],
		planFrom: read.planFrom ?? null,
		missed: read.missed ?? [],
	};
}
