/**
 * Holds a key down in a terminal session for a daemon that has no holdKey of
 * its own: a worker thread with its own clock and its own line to the daemon.
 * Claude's hold-to-talk lets the key go at a 100ms gap between two repeats,
 * and main's event loop stalls that long several times a minute (measured),
 * so main must not be the one keeping time.
 *
 * Messages from main: { type: "hold", sessionId, data, everyMs } and
 * { type: "release", sessionId }.
 */
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { parentPort, workerData } from "node:worker_threads";
import { PROTOCOL_VERSION } from "./lib/terminal-host/types";

if (!parentPort) {
	throw new Error("hold-key-worker must be run in a worker thread");
}
const port = parentPort;
const { socketPath, tokenPath } = workerData as {
	socketPath: string;
	tokenPath: string;
};

let socket: Socket | null = null;
let connecting: Promise<Socket> | null = null;
let seq = 0;

/** A control connection to the daemon, made on first use and after a drop. */
function daemon(): Promise<Socket> {
	if (socket) return Promise.resolve(socket);
	if (connecting) return connecting;
	connecting = new Promise<Socket>((resolve, reject) => {
		const s = connect(socketPath);
		let buf = "";
		const fail = (error: Error) => {
			connecting = null;
			socket = null;
			reject(error);
		};
		s.once("error", fail);
		s.on("close", () => {
			socket = null;
			connecting = null;
		});
		s.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				let reply: { id?: string; success?: boolean; error?: unknown };
				try {
					reply = JSON.parse(line);
				} catch {
					continue;
				}
				if (reply.id !== "hello") continue;
				if (reply.success === false) {
					fail(new Error(`hello refused: ${JSON.stringify(reply.error)}`));
					s.destroy();
					return;
				}
				socket = s;
				connecting = null;
				resolve(s);
			}
		});
		s.once("connect", () => {
			s.write(
				`${JSON.stringify({
					id: "hello",
					type: "hello",
					payload: {
						token: readFileSync(tokenPath, "utf8").trim(),
						protocolVersion: PROTOCOL_VERSION,
						clientId: `hold-key-${process.pid}`,
						role: "control",
					},
				})}\n`,
			);
		});
	});
	return connecting;
}

const held = new Map<string, ReturnType<typeof setInterval>>();

function release(sessionId: string): void {
	const timer = held.get(sessionId);
	if (timer) clearInterval(timer);
	held.delete(sessionId);
}

async function hold(
	sessionId: string,
	data: string,
	everyMs: number,
): Promise<void> {
	release(sessionId);
	const s = await daemon();
	// A notify_ id: the daemon sends no reply, so nothing piles up.
	const write = () =>
		s.write(
			`${JSON.stringify({
				id: `notify_hold_${++seq}`,
				type: "write",
				payload: { sessionId, data },
			})}\n`,
		);
	const started = Date.now();
	write();
	held.set(
		sessionId,
		setInterval(() => {
			// ponytail: a 60s cap, for a release that never arrives.
			if (s.destroyed || Date.now() - started > 60_000) {
				release(sessionId);
				return;
			}
			write();
		}, everyMs),
	);
}

port.on(
	"message",
	(message: {
		type: "hold" | "release";
		sessionId: string;
		data?: string;
		everyMs?: number;
	}) => {
		if (message.type === "release") release(message.sessionId);
		else
			hold(message.sessionId, message.data ?? " ", message.everyMs ?? 30).catch(
				(error) => port.postMessage({ type: "error", message: String(error) }),
			);
	},
);
