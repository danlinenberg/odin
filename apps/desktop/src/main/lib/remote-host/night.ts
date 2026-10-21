/**
 * The Night Agent on the remote host, so it runs with the laptop closed.
 *
 * While the laptop is awake, Odin ranks tonight's tasks as it always has and
 * sends the host a plan: the window as absolute times, the cap, and each task
 * as a ready-to-run session script. A runner on the host (a systemd timer,
 * every minute, as the user's own Linux user) starts them one at a time in tmux, each
 * once the last one's turn ended (the turn-end hook's marker). When the
 * laptop wakes, Odin reads what the host started and puts those sessions on
 * the board.
 */
import { sh } from "./session";
import { adminLogin, connectHost, type HostLogin, runOnHost } from "./ssh";

/** The placeholder a task's run script names its secrets dir by. */
export const SECRETS_DIR_PLACEHOLDER = "__ODIN_SECRETS_DIR__";

export interface NightTask {
	key: string;
	title: string;
	sessionId: string;
	/** runScript() output with the secrets dir as SECRETS_DIR_PLACEHOLDER. */
	script: string;
}

export interface NightPlan {
	/** Changes with every plan, so the host knows a new night from a resend. */
	id: string;
	/** The window, as epoch seconds - the host's clock and timezone don't matter. */
	from: number;
	to: number;
	cap: number;
	tasks: NightTask[];
}

export interface NightStarted {
	key: string;
	title: string;
	sessionId: string;
	at: number;
}

export const NIGHT_RUNNER_PY = `import json, os, shutil, subprocess, tempfile, time

HOME = os.path.expanduser("~/.odin/night")
PLAN, STATE = HOME + "/plan.json", HOME + "/state.json"


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def session_name(session):
    return "odin-" + "".join(c if c.isalnum() or c in "_-" else "-" for c in session)[:60]


def alive(session):
    return subprocess.run(["tmux", "has-session", "-t", session_name(session)], capture_output=True).returncode == 0


plan = load(PLAN, None)
now = time.time()
if not plan or not plan["from"] <= now < plan["to"]:
    raise SystemExit
state = load(STATE, {})
if state.get("plan") != plan["id"] and state.get("night") != plan["from"]:
    state = {"plan": plan["id"], "night": plan["from"], "started": []}
state["plan"] = plan["id"]
started = state["started"]
if len(started) >= plan["cap"]:
    raise SystemExit
if started:
    last = started[-1]["sessionId"]
    if alive(last) and not os.path.exists(HOME + "/stopped/" + last):
        raise SystemExit
done = {s["key"] for s in started}
task = next((t for t in plan["tasks"] if t["key"] not in done), None)
if not task:
    raise SystemExit
secrets = tempfile.mkdtemp(prefix="odin.", dir="/dev/shm")
shutil.copyfile(HOME + "/env", secrets + "/env")
os.chmod(secrets + "/env", 0o600)
with open(secrets + "/run.sh", "w") as f:
    f.write(task["script"].replace("${SECRETS_DIR_PLACEHOLDER}", secrets))
subprocess.run(["tmux", "new-session", "-d", "-s", session_name(task["sessionId"]), "bash " + secrets + "/run.sh"], check=True)
started.append({"key": task["key"], "title": task["title"], "sessionId": task["sessionId"], "at": now})
with open(STATE + ".new", "w") as f:
    json.dump(state, f)
os.replace(STATE + ".new", STATE)
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
			const admin = await connectHost(adminLogin(host));
			await runOnHost(
				admin,
				`sudo -n bash -c ${sh(nightInstallScript(host.user))}`,
			).finally(() => admin.end());
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

/** What the host's runner started for the current plan, oldest first. */
export async function readNightStarted(
	host: HostLogin,
): Promise<NightStarted[]> {
	const client = await connectHost(host);
	try {
		const raw = await runOnHost(
			client,
			"cat ~/.odin/night/state.json 2>/dev/null || echo '{}'",
		);
		const state = JSON.parse(raw || "{}") as { started?: NightStarted[] };
		return state.started ?? [];
	} finally {
		client.end();
	}
}
