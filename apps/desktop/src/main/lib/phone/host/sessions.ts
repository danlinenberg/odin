import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ActiveSession } from "shared/active-sessions";
import { odinScreenStatus } from "shared/odin-screen-status";
import type { PaneStatus } from "shared/tabs-types";

/**
 * The sessions Odin runs on this host, as the phone server here sees them
 * (phone-host): one tmux session per Claude conversation, `odin-<session id>`
 * (session.ts). Which card on the laptop's board each one is comes from the
 * file the run script leaves in ~/.odin/panes, and the board the laptop last
 * sent (`board.json`) gives each its title and tags.
 */

/** Where the phone server keeps its files; a test points it at a temp dir. */
export const hostPaths = {
	home: homedir(),
	get odin() {
		return join(this.home, ".odin");
	},
	get dir() {
		return join(this.odin, "phone-host");
	},
	/** Claude's transcripts, as claude-sessions' projectsRoot on this host. */
	get projects() {
		return join(this.home, ".claude", "projects");
	},
};

/** A card as the laptop's board last showed it, with its Claude session. */
export type SnapshotCard = ActiveSession & { sessionId: string };

/** What the laptop sends: its remote cards on this host, and the host's name. */
export type BoardSnapshot = { host?: string; sessions?: SnapshotCard[] };

export function readSnapshot(): BoardSnapshot {
	try {
		const parsed = JSON.parse(
			readFileSync(join(hostPaths.dir, "board.json"), "utf8"),
		);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** tmux session name -> the laptop card's id, from the run scripts' files. */
export function readPaneFiles(): Map<string, string> {
	const dir = join(hostPaths.odin, "panes");
	const out = new Map<string, string>();
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		try {
			const pane = readFileSync(join(dir, name), "utf8").trim();
			if (pane) out.set(name, pane);
		} catch {}
	}
	return out;
}

/** Runs tmux; a test swaps it. */
export const tmux = {
	run: async (args: string[]): Promise<string> =>
		(await promisify(execFile)("tmux", args, { timeout: 10_000 })).stdout,
};

/** What runs on this host; a test swaps it. */
export const procs = {
	/** The pids with a `claude` child: one `ps` for every session. */
	claudeParents: async (): Promise<Set<string>> => {
		const out = await promisify(execFile)(
			"ps",
			["-o", "ppid=", "-C", "claude"],
			{ timeout: 10_000 },
		).then(
			(ran) => ran.stdout,
			// ps exits 1 when no claude runs.
			() => "",
		);
		return new Set(out.split("\n").map((pid) => pid.trim()));
	},
};

/**
 * The live `odin-*` tmux sessions: name, when it started (epoch seconds),
 * and whether its Claude runs. Claude is a child of the pane's run script
 * (session.ts), so tmux names the pane's command `bash` either way.
 */
export async function liveSessions(): Promise<
	{ name: string; sessionId: string; claude: boolean; created: number }[]
> {
	const [out, parents] = await Promise.all([
		tmux
			.run([
				"list-sessions",
				"-F",
				"#{session_name}\t#{pane_pid}\t#{session_created}",
			])
			.catch(() => ""),
		procs.claudeParents(),
	]);
	return out
		.split("\n")
		.map((line) => line.split("\t"))
		.filter(([name]) => name?.startsWith("odin-") && name.length > 5)
		.map(([name = "", pid = "", created = ""]) => ({
			name,
			sessionId: name.slice(5),
			claude: parents.has(pid),
			created: Number(created),
		}));
}

/** The pane's screen, as plain text; "" when tmux can't read it. */
export const readScreen = (name: string) =>
	tmux.run(["capture-pane", "-p", "-t", name]).catch(() => "");

/** A host session as the phone's board row, before its title is known. */
export type HostSession = {
	paneId: string;
	sessionId: string;
	tmux: string;
	claude: boolean;
	card: SnapshotCard | null;
};

/**
 * A session started this long before the laptop sent its board can be
 * missing from it: its card has no Claude session yet.
 */
const NEW_CARD_SECONDS = 600;

/** When the laptop last sent its board (epoch seconds); 0 when it never did. */
function snapshotSentAt(): number {
	try {
		return statSync(join(hostPaths.dir, "board.json")).mtimeMs / 1000;
	} catch {
		return 0;
	}
}

/**
 * Every Odin session alive in tmux here, with the laptop card it belongs to.
 * Done on the laptop takes the card off its board and leaves the tmux
 * session, so one with no card on the board the laptop sent is listed only
 * when it started after that board: the runner's, or one the laptop started
 * since. A host the laptop never sent a board lists them all.
 */
export async function hostSessions(): Promise<HostSession[]> {
	const live = await liveSessions();
	const files = readPaneFiles();
	const cards = readSnapshot().sessions;
	const sentAt = snapshotSentAt();
	return live.flatMap((session) => {
		const card =
			cards?.find((c) => c.sessionId === session.sessionId) ??
			cards?.find((c) => c.paneId === files.get(session.name)) ??
			null;
		if (!card && cards && session.created < sentAt - NEW_CARD_SECONDS)
			return [];
		return {
			paneId: card?.paneId ?? files.get(session.name) ?? session.sessionId,
			sessionId: session.sessionId,
			tmux: session.name,
			claude: session.claude,
			card,
		};
	});
}

/** The host session the phone names by its laptop card's id (or its session id). */
export async function findSession(paneId: string): Promise<HostSession | null> {
	return (
		(await hostSessions()).find(
			(s) => s.paneId === paneId || s.sessionId === paneId,
		) ?? null
	);
}

/**
 * Where the board files it, from its screen: a dialog or a spinner says so
 * plainly. At its prompt, the laptop's last word stands (a question asked in
 * prose looks the same as a finished turn), unless that said Working.
 * A Claude that isn't running (stopped for being idle) is Idle.
 */
export function hostStatus(
	screen: string,
	claude: boolean,
	last: PaneStatus | undefined,
): PaneStatus {
	if (!claude) return "idle";
	const read = odinScreenStatus(screen);
	if (read === "review") return last && last !== "working" ? last : "review";
	return read ?? last ?? "idle";
}

/** A task the laptop sent for the phone to start here (remote-host/away). */
export type AwayTask = { id: string; title: string; started: boolean };

/** What the laptop left here with Tasks with the Mac closed on (remote-host/away). */
export interface AwayList {
	tasks?: { key: string; title: string }[];
	/** Epoch seconds: after it, the host lists and starts nothing. */
	until?: number;
	/** What the host fetches the board with (feeds.ts); absent from older laptops. */
	feeds?: import("./feeds").HostFeeds;
	/** Done on the laptop, so the host's board leaves it out. */
	done?: import("./feeds").HostDone;
	/** My own Tasks on the laptop (not automations), for the host's board. */
	todos?: import("renderer/routes/_authenticated/_odin/hooks/odin-task").OdinTask[];
}

/** The laptop's list, or null when there is none or it expired. */
export function readAway(now = Date.now()): AwayList | null {
	try {
		const away = JSON.parse(
			readFileSync(join(hostPaths.odin, "night", "away.json"), "utf8"),
		) as AwayList;
		return away && now / 1000 < (away.until ?? 0) ? away : null;
	} catch {
		return null;
	}
}

/** What the runner started here (its ledger). */
export function ranRows(): { key: string; sessionId: string }[] {
	try {
		return readFileSync(join(hostPaths.odin, "night", "ran.jsonl"), "utf8")
			.split("\n")
			.flatMap((line) => {
				try {
					return line ? [JSON.parse(line)] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

/** The task keys the runner started here. */
export const ranKeys = () => new Set(ranRows().map((row) => row.key));

/**
 * The tasks the laptop left here, then the host's own board rows (feeds.ts),
 * not started yet (the runner's ledger says which were), in that order. None
 * once the list expired: the laptop has been away longer than it covers.
 */
export function awayBacklog(
	now = Date.now(),
	board: { key: string; title: string }[] = [],
	/** Put away on the phone here (inbox.ts). */
	done: Iterable<string> = [],
): AwayTask[] {
	const away = readAway(now);
	if (!away) return [];
	const skip = ranKeys();
	for (const key of done) skip.add(key);
	const rows: AwayTask[] = [];
	for (const task of [...(away.tasks ?? []), ...board]) {
		if (skip.has(task.key)) continue;
		skip.add(task.key);
		rows.push({ id: task.key, title: task.title, started: false });
	}
	return rows;
}
