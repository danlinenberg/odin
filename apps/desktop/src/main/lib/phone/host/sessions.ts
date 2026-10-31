import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

/** The live `odin-*` tmux sessions: name, and whether Claude is the pane's command. */
export async function liveSessions(): Promise<
	{ name: string; sessionId: string; claude: boolean }[]
> {
	const out = await tmux
		.run(["list-sessions", "-F", "#{session_name}\t#{pane_current_command}"])
		.catch(() => "");
	return out
		.split("\n")
		.map((line) => line.split("\t"))
		.filter(([name]) => name?.startsWith("odin-") && name.length > 5)
		.map(([name = "", command = ""]) => ({
			name,
			sessionId: name.slice(5),
			claude: command === "claude",
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

/** Every Odin session alive in tmux here, with the laptop card it belongs to. */
export async function hostSessions(): Promise<HostSession[]> {
	const live = await liveSessions();
	const files = readPaneFiles();
	const cards = readSnapshot().sessions ?? [];
	return live.map((session) => {
		const card =
			cards.find((c) => c.sessionId === session.sessionId) ??
			cards.find((c) => c.paneId === files.get(session.name)) ??
			null;
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
