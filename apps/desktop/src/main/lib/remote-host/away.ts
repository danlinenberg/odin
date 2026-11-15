/**
 * Tasks with the Mac closed (Settings > Remote > Phone): an opt-in copy of
 * the top of Next in line on the remote host, so the phone lists them and
 * starts one there while this computer is asleep or shut.
 *
 * Built the way the Night Agent's plan is (night.ts): this computer builds
 * each task's session script, so the host never builds a command from what a
 * phone sends. The phone names a task by its key and the host starts the
 * script it already has for that key, or nothing. The list goes over the
 * same SSM connection as everything else for the host (encrypted, signed in
 * with your AWS role), into files only the host user can read (0600), and
 * it stops working at `until`. Turning the switch off deletes it there.
 * When this computer wakes, the board adopts what the phone started, from
 * the runner's ledger.
 */

import type { OdinTask } from "renderer/routes/_authenticated/_odin/hooks/odin-task";
import type { HostDone, HostFeeds } from "../phone/host/feeds";
import type { AddedTask, DoneMark } from "../phone/host/inbox";
import { ensureNightRunner, NIGHT_RUNNER_PY, type NightTask } from "./night";
import { sh } from "./session";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

/** The list on the host, beside the night plan. */
export interface AwayTasks {
	tasks: NightTask[];
	/** Epoch seconds after which the host lists and starts none of them. */
	until: number;
	/**
	 * The host's own board (phone/host/feeds): a session template any row it
	 * fetched starts in (only the row's text goes in), what it fetches with,
	 * and what is done here. Absent: the host lists `tasks` alone.
	 */
	template?: { script: string; prompt: string };
	feeds?: HostFeeds;
	done?: HostDone;
	/** My own Tasks here, for the host's board. */
	todos?: OdinTask[];
}

/** How long a sent list stays good with this computer away: the night plan's reach. */
export const AWAY_DAYS = 3;

const write = (name: string) =>
	`umask 077; mkdir -p ~/.odin/night/stopped && cat > ~/.odin/night/${name}.new && mv ~/.odin/night/${name}.new ~/.odin/night/${name}`;

/** Sends the list and the secrets its sessions start with, and the files their prompts name. */
export async function pushAwayTasks(
	host: HostLogin,
	away: AwayTasks,
	secrets: string,
	files: { local: string; remote: string }[],
): Promise<void> {
	const client = await connectHost(host);
	try {
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
		// The runner the phone server starts a task with (`start <key>`).
		await runOnHost(client, write("runner.py"), NIGHT_RUNNER_PY);
		await runOnHost(client, write("away.json"), JSON.stringify(away));
	} finally {
		client.end();
	}
}

/**
 * An automation the host starts on its own while this computer is away: the
 * session it runs in, built here (a fresh id goes in place of the
 * placeholder there), and its next run times as this computer's clock puts
 * them, so the host's timezone doesn't matter.
 */
export interface HostSchedule {
	/** The automation's id. */
	key: string;
	title: string;
	/** A session template's script and prompt (remote-host router's sessionTemplate). */
	script: string;
	prompt: string;
	/** Epoch seconds. */
	at: number[];
}

/**
 * Sends the automations and the secrets their sessions start with. The
 * host's every-minute runner starts a run this computer didn't take
 * (night.ts run_schedules), so it installs that runner when it's missing.
 */
export async function pushSchedules(
	host: HostLogin,
	schedules: HostSchedule[],
	secrets: string,
	files: { local: string; remote: string }[],
): Promise<void> {
	const client = await connectHost(host);
	try {
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
		// The runner this computer takes a run with (`claim <key>`).
		await runOnHost(client, write("runner.py"), NIGHT_RUNNER_PY);
		await runOnHost(
			client,
			write("schedules.json"),
			JSON.stringify({
				schedules,
				until: Math.floor(Date.now() / 1000) + AWAY_DAYS * 86_400,
			}),
		);
		if (schedules.length) await ensureNightRunner(client, host);
	} finally {
		client.end();
	}
}

/** The key a run of an automation goes by in the host's ledger, either side. */
export const scheduledRunKey = (schedule: string, slot: number) =>
	`auto:${schedule}:${Math.floor(slot)}`;

/**
 * Takes a run on the host before this computer starts it: false when the
 * host's runner already started that run while this computer was away.
 */
export async function claimScheduledRun(
	host: HostLogin,
	key: string,
): Promise<boolean> {
	const client = await connectHost(host);
	try {
		const out = await runOnHost(
			client,
			`python3 ~/.odin/night/runner.py claim ${sh(key)}`,
		);
		return out.trim().split("\n").pop() !== "already";
	} finally {
		client.end();
	}
}

/**
 * Switch off: the list goes, and the secrets with it unless a night plan
 * still needs them. The ledger stays, so nothing it started runs twice.
 */
export const clearAwayScript =
	"rm -f ~/.odin/night/away.json ~/.odin/night/schedules.json ~/.odin/night/board.json ~/.odin/night/added.jsonl ~/.odin/night/done.jsonl ~/.odin/night/runner.py; [ -f ~/.odin/night/plan.json ] || rm -f ~/.odin/night/env";

export async function clearAwayTasks(host: HostLogin): Promise<void> {
	const client = await connectHost(host);
	try {
		await runOnHost(client, clearAwayScript);
	} finally {
		client.end();
	}
}

/**
 * Prints what the phone did on the host with this computer away (phone/host
 * inbox) as one JSON line, and with an argument (epoch ms) first drops what
 * is that old or older: what this computer already took in.
 */
export const AWAY_INBOX_PY = `import json, os, sys
night = os.path.expanduser("~/.odin/night")
def rows(name):
    try:
        with open(os.path.join(night, name)) as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out
if len(sys.argv) > 1:
    before = float(sys.argv[1])
    os.umask(0o077)
    for name in ("added.jsonl", "done.jsonl"):
        keep = [r for r in rows(name) if float(r.get("at") or 0) > before]
        path = os.path.join(night, name)
        if not os.path.exists(path):
            continue
        with open(path + ".new", "w") as f:
            f.write("".join(json.dumps(r) + "\\n" for r in keep))
        os.replace(path + ".new", path)
print(json.dumps({"added": rows("added.jsonl"), "done": rows("done.jsonl")}))
`;

/** What the phone typed and put away on the host; with `before`, what's that old is dropped first. */
export async function awayInbox(
	host: HostLogin,
	before?: number,
): Promise<{ added: AddedTask[]; done: DoneMark[] }> {
	const client = await connectHost(host);
	try {
		const raw = await runOnHost(
			client,
			`python3 -c ${sh(AWAY_INBOX_PY)}${before === undefined ? "" : ` ${Math.floor(before)}`}`,
		);
		const line = raw.trim().split("\n").pop() ?? "{}";
		const read = JSON.parse(line) as { added?: AddedTask[]; done?: DoneMark[] };
		return { added: read.added ?? [], done: read.done ?? [] };
	} finally {
		client.end();
	}
}
