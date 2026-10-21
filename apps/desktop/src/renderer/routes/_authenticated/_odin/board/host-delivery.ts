import { claudeDrawn, remoteConnectLine } from "shared/odin-screen-status";

/** What delivery needs from the pane, injected so tests run on a fake clock. */
export type HostDeps = {
	readScreen: () => Promise<string>;
	sleep: (ms: number) => Promise<void>;
	/** The pane is still open. */
	alive: () => boolean;
};

/** A message on its way into a remote session's Claude. */
export type HostMessage = {
	/** Pastes and types it into the PTY. */
	type: () => Promise<void>;
	/** Claude took it: a new user row, or the message in its queue. */
	arrived: () => boolean;
	/** The bubble says it waits for the host (on), or that it went in (off). */
	waiting: (on: boolean) => void;
	/** It never reached Claude: the bubble says Not delivered. */
	lost: () => void;
};

/** Claude's own screen is up, after the last connect line. */
export function hostReady(screen: string): boolean {
	return claudeDrawn(screen) && !remoteConnectLine(screen);
}

const POLL_MS = 500;
/** A host rebooting after it ran out of memory takes minutes, not seconds. */
const WAIT_MAX_MS = 30 * 60_000;
/** Claude logs a message the moment it takes it, as a turn or queued. */
const ARRIVE_MS = 10_000;
/**
 * How long after a send a drop still counts against it: the helper notices a
 * dead connection after three missed 10s keepalives, then says so.
 */
const DROP_WATCH_MS = 45_000;
/** After a reconnect, time for the transcript to catch up before typing again. */
const SETTLE_MS = 3_000;

const read = (deps: HostDeps) => deps.readScreen().catch(() => "");

/** Until Claude is drawn on the host; false when the pane closed or it never came. */
async function untilReady(deps: HostDeps): Promise<boolean> {
	for (let waited = 0; waited < WAIT_MAX_MS; waited += POLL_MS) {
		if (!deps.alive()) return false;
		if (hostReady(await read(deps))) return true;
		await deps.sleep(POLL_MS);
	}
	return false;
}

/** Each pane's deliveries, one after another: two replies typed at once interleave. */
const lines = new Map<string, Promise<unknown>>();

function inLine<T>(paneId: string, job: () => Promise<T>): Promise<T> {
	const run = (lines.get(paneId) ?? Promise.resolve()).then(job, job);
	const tail = run.catch(() => undefined);
	lines.set(paneId, tail);
	void tail.then(() => {
		if (lines.get(paneId) === tail) lines.delete(paneId);
	});
	return run;
}

type Outcome = "took" | "lost" | "gone";

async function typeWhenReady(
	message: HostMessage,
	deps: HostDeps,
	again: boolean,
): Promise<Outcome> {
	if (!hostReady(await read(deps))) {
		message.waiting(true);
		if (!(await untilReady(deps))) return "gone";
	}
	// Claude may have taken the first one after all: its transcript was out
	// of reach while the connection was down.
	if (again) {
		await deps.sleep(SETTLE_MS);
	}
	message.waiting(false);
	if (again && message.arrived()) return "took";
	await message.type();
	for (let waited = 0; waited < ARRIVE_MS; waited += POLL_MS) {
		if (message.arrived()) return "took";
		await deps.sleep(POLL_MS);
	}
	return message.arrived() ? "took" : "lost";
}

/**
 * Types a reply into a remote session's Claude. While the pane reaches the
 * host (a dropped connection, tmux restarted, the host rebooting) the PTY
 * has no Claude in it: what goes in meanwhile lands in the connect step and
 * is lost. So the reply waits for Claude's screen, behind any reply sent
 * before it. One typed into a connection that dropped right after goes in
 * again once the host is back, unless Claude took it; one that still never
 * arrives reads Not delivered.
 */
export async function deliverOnHost(
	paneId: string,
	message: HostMessage,
	deps: HostDeps,
): Promise<void> {
	// Behind an earlier reply still on its way: it waits too.
	if (lines.has(paneId)) message.waiting(true);
	const first = await inLine(paneId, () => typeWhenReady(message, deps, false));
	if (first === "took") return;
	message.lost();
	if (first === "gone") return;
	for (let waited = 0; waited < DROP_WATCH_MS; waited += POLL_MS) {
		if (message.arrived()) return;
		if (remoteConnectLine(await read(deps))) {
			message.waiting(true);
			const again = await inLine(paneId, () =>
				typeWhenReady(message, deps, true),
			);
			if (again !== "took") message.lost();
			return;
		}
		await deps.sleep(POLL_MS);
	}
}
