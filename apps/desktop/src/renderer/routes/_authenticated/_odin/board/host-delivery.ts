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

/**
 * Baseline: waits until Claude is drawn, up to two minutes, then types.
 */
export async function deliverOnHost(
	_paneId: string,
	message: HostMessage,
	deps: HostDeps,
): Promise<void> {
	for (let waited = 0; waited < 120_000; waited += 500) {
		if (hostReady(await deps.readScreen().catch(() => ""))) break;
		await deps.sleep(500);
	}
	await message.type();
}
