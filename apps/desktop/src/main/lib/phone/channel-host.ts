import {
	acceptChannel,
	type ChannelRequest,
	type ChannelResponse,
	connectSocket,
	type Pipe,
	websocketPipe,
} from "@odin/channel";
import type { Trust } from "./trust";

/**
 * The host's half of the phone channel (docs/phone-encryption.md), shared by
 * Odin on this computer (server.ts) and the phone server on a remote host
 * (phone-host): the handshake against the host's trust, and the control
 * connection to the relay that announces each phone.
 */

/** `phone`: the key of the phone that sent it, from the handshake. */
export type Handler = (
	request: ChannelRequest,
	phone: Uint8Array,
) => Promise<ChannelResponse>;

/** Open channels by phone key, so removing a phone cuts it off at once. */
export type LiveChannels = Map<string, Set<Pipe>>;

/** Answers one phone's channel: the handshake, then its requests. */
export function serveChannel(
	pipe: Pipe,
	trust: Pick<Trust, "identity" | "accept">,
	handle: Handler,
	live?: LiveChannels,
): void {
	acceptChannel(pipe, {
		me: trust.identity(),
		accept: (phone, hello) => {
			if (!trust.accept(phone, hello)) return false;
			if (live) {
				const key = Buffer.from(phone).toString("base64url");
				const set = live.get(key) ?? new Set();
				set.add(pipe);
				live.set(key, set);
				pipe.onClose(() => set.delete(pipe));
			}
			return true;
		},
		handle,
	});
}

export type RelayState = "connecting" | "connected";

/**
 * How often the control connection is opened again. Nothing travels on it
 * between phones, so one the relay dropped while this computer slept or
 * changed network never closes here: the relay then tells every phone there
 * is no such host, with Odin open and "connected".
 */
const REDIAL_MS = 60_000;

/**
 * Keeps a control connection open to the relay under `id` and hands each
 * phone it announces to `onPhone`. Backs off and dials again after a close,
 * and opens a new connection every `redialMs`: the relay keeps the newest,
 * and the old one stays until the new one is up. Returns the stop.
 */
export function dialRelay(
	url: string,
	id: string,
	onPhone: (pipe: Pipe) => void,
	onState: (state: RelayState) => void = () => {},
	redialMs = REDIAL_MS,
): () => void {
	let stopped = false;
	let control: WebSocket | null = null;
	let delay = 1000;
	const connect = (redial = false) => {
		if (stopped) return;
		if (!redial) onState("connecting");
		const old = redial ? control : null;
		const socket = new WebSocket(`${url}/host/${id}`);
		control = socket;
		socket.addEventListener("open", () => {
			old?.close();
			if (!redial) onState("connected");
			delay = 1000;
		});
		socket.addEventListener("message", async (event) => {
			let incoming: unknown;
			try {
				incoming = JSON.parse(String(event.data)).incoming;
			} catch {
				return;
			}
			if (typeof incoming !== "string" || !/^[0-9a-f]{32}$/.test(incoming))
				return;
			const session = await connectSocket(`${url}/accept/${incoming}`).catch(
				() => null,
			);
			if (session) onPhone(websocketPipe(session));
		});
		socket.addEventListener("close", () => {
			// One a newer connection took over from: that one is the state now.
			if (control !== socket) return;
			old?.close();
			onState("connecting");
			if (stopped) return;
			setTimeout(connect, delay);
			delay = Math.min(delay * 2, 60_000);
		});
	};
	connect();
	// Only over an open one: a closed one is already dialing again above.
	const redial = setInterval(() => {
		if (control?.readyState === WebSocket.OPEN) connect(true);
	}, redialMs);
	return () => {
		stopped = true;
		clearInterval(redial);
		control?.close();
	};
}
