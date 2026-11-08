/**
 * How a remote session's pane keeps its terminal attached to the host: the
 * connect, attach and retry loop, apart from ssh2 and AWS so it can be tested.
 * A host that stays out of reach, or a login or attach that keeps failing on
 * a host that is up, ends after MAX_TRIES in a stopped state that says why
 * and offers what to do. Left alone, the stopped state tries once more by
 * itself after STUCK_RETRY_MS, waiting twice as long after each miss up to
 * STUCK_RETRY_MAX_MS, so a host that comes back is picked up without a click.
 */

/** Failed tries in a row before the pane stops and asks what to do. */
export const MAX_TRIES = 6;
/** One login (SSM stream, key push, SSH handshake) may take this long. */
export const LOGIN_TIMEOUT_MS = 3 * 60_000;
/** An attach that dropped sooner than this counts as a failed try. */
export const STABLE_MS = 60_000;
/** The stopped state's first try by itself; it doubles after each miss. */
export const STUCK_RETRY_MS = 5 * 60_000;
/** The longest the stopped state waits before it tries by itself again. */
export const STUCK_RETRY_MAX_MS = 30 * 60_000;

/**
 * Puts the pane's terminal back once tmux on the host is gone: scroll region,
 * main screen, mouse off, cursor shown, screen cleared. A dropped connection
 * never lets tmux undo its full-screen mode, so "connection lost" was written
 * where tmux left the cursor, inside Claude's old input box, with the rest of
 * Claude's screen still below it. The chat read that as Claude still there and
 * typed a reply into the reconnect, where it was lost: Not delivered.
 */
export const LEAVE_TMUX_SCREEN =
	"\x1b[r\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[H\x1b[2J";

/**
 * What you picked once the pane stopped reconnecting, or "auto" when nobody
 * picked before the stopped state's own retry came due.
 */
export type StuckChoice = "retry" | "fresh" | "reboot" | "auto";

export interface ReconnectIo<C> {
	/** One login to the host; throws when it fails. */
	connect: () => Promise<C>;
	/**
	 * Attaches to the session's tmux. Resolves true when the connection
	 * dropped, false when the session ended there. `fresh` ends the session's
	 * tmux first, so Claude starts over and resumes the conversation.
	 */
	attach: (client: C, first: boolean, fresh: boolean) => Promise<boolean>;
	/** Waits `ms` before the next try; true when you asked for a reboot. */
	pause: (ms: number, offerReboot: boolean) => Promise<boolean>;
	reboot: () => Promise<void>;
	/**
	 * After MAX_TRIES failed tries: says why, then waits for your pick, or
	 * resolves "auto" once `retryInMs` passed with no pick.
	 */
	stuck: (
		reason: string,
		tries: number,
		retryInMs: number,
	) => Promise<StuckChoice>;
	say: (text: string) => void;
	/** A failure no retry can fix (AWS refused by policy): the pane ends. */
	fatal: (err: unknown) => boolean;
	now?: () => number;
	random?: () => number;
}

const message = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

/**
 * Connects and keeps the session attached until it ends on the host. The
 * wait between tries doubles up to 5 minutes, with jitter, so a host's panes
 * don't all retry together; after 3 tries R reboots the host.
 */
export async function keepAttached<C>(
	io: ReconnectIo<C>,
	/** The host as the user knows it: its name, else its instance id. */
	host: string,
): Promise<void> {
	const now = io.now ?? Date.now;
	const random = io.random ?? Math.random;
	let tries = 0;
	// Failed tries since the last attach that held or your last pick: what the
	// stopped state counts, across its own retries too.
	let streak = 0;
	let wait = 10_000;
	let stuckWait = STUCK_RETRY_MS;
	let fresh = false;
	const settle = () => {
		tries = 0;
		streak = 0;
		wait = 10_000;
		stuckWait = STUCK_RETRY_MS;
	};
	const reboot = async () => {
		try {
			await io.reboot();
			settle();
		} catch (err) {
			io.say(`could not reboot: ${message(err)}`);
		}
	};
	const failed = async (reason: string): Promise<void> => {
		tries++;
		streak++;
		if (tries >= MAX_TRIES) {
			const choice = await io.stuck(reason, streak, stuckWait);
			if (choice === "auto") {
				// One try, and back to the stopped state if it misses, waiting
				// longer: a host that is down for hours costs a login every 30m.
				tries = MAX_TRIES - 1;
				stuckWait = Math.min(stuckWait * 2, STUCK_RETRY_MAX_MS);
			} else settle();
			if (choice === "fresh") fresh = true;
			if (choice === "reboot") await reboot();
			// A new connect line replaces "Stopped reconnecting" on screen. Without
			// it the chat kept showing Retry until the next login ended (up to
			// LOGIN_TIMEOUT_MS), and the click looked like it did nothing.
			else
				io.say(
					fresh
						? `connecting to ${host} to start Claude over...`
						: `connecting to ${host}...`,
				);
			return;
		}
		const delay = wait / 2 + random() * (wait / 2);
		const offer = tries >= 3;
		io.say(
			`${reason} - trying again in ${Math.round(delay / 1000)}s${offer ? ` (press R to reboot ${host})` : ""}`,
		);
		wait = Math.min(wait * 2, 300_000);
		if (await io.pause(delay, offer)) await reboot();
	};
	const login = async (): Promise<C> => {
		for (;;) {
			try {
				return await io.connect();
			} catch (err) {
				if (io.fatal(err)) throw err;
				await failed(`could not reconnect: ${message(err)}`);
			}
		}
	};
	io.say(`connecting to ${host}...`);
	for (let first = true; ; first = false) {
		const client = await login();
		const startedAt = now();
		let reason: string | null = null;
		const dropped = await io.attach(client, first, fresh).catch((err) => {
			reason = `could not attach: ${message(err)}`;
			return true;
		});
		fresh = false;
		if (!dropped) return;
		// A host that takes the login but loses the session right away (tmux
		// gone wrong, a setup step failing) looped here for good, never
		// waiting and never saying so. It counts as a failed try instead.
		if (reason || now() - startedAt < STABLE_MS)
			await failed(
				reason ??
					`could not reconnect: the session on ${host} dropped right away`,
			);
		else settle();
		io.say(`connection lost - reconnecting to ${host}...`);
	}
}

/** The few ssh2 Client events a login waits on. */
interface Readyable {
	once(event: "ready" | "close" | "end", listener: () => void): unknown;
	on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Resolves once the SSH login is done; rejects on an error, and when the
 * connection ends first. Once sshd's greeting has arrived, an SSM stream that
 * ends (the plugin exited 0, sshd dropped the connection) gives ssh2 only
 * "end" and "close", no error, and it clears its own ready timeout as well: a login waiting on ready or error alone
 * never settled, and the pane sat on "reconnecting" forever.
 */
export function untilReady(
	client: Readyable,
	onFail: () => void,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let ready = false;
		client.once("ready", () => {
			ready = true;
			resolve();
		});
		// Not once: a handshake timeout emits an error, then the SSM socket's
		// abort emits another, and an unheard one crashes the helper.
		client.on("error", (err) => {
			onFail();
			reject(err);
		});
		const closed = () => {
			if (ready) return;
			onFail();
			reject(
				new Error("the host closed the connection before the login finished"),
			);
		};
		client.once("end", closed);
		client.once("close", closed);
	});
}

/**
 * Rejects after `ms` with "<what> timed out". A result that comes after that
 * goes to `discard`, so a late login doesn't stay open behind the pane.
 */
export function settleWithin<T>(
	ms: number,
	what: string,
	work: Promise<T>,
	discard: (late: T) => void = () => {},
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let late = false;
		const timer = setTimeout(() => {
			late = true;
			reject(new Error(`${what} timed out`));
		}, ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				if (late) discard(value);
				else resolve(value);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}
