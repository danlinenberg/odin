/**
 * The blind relay (docs/phone-encryption.md). It joins a phone's WebSocket to
 * the Odin host it asked for and forwards bytes both ways. It never parses
 * them and never holds a key: everything it carries is a Noise message,
 * readable only by the phone and the host.
 *
 *   /host/<id>       the host's control connection: "{incoming: <session>}"
 *   /connect/<id>    a phone, for the host with that relay ID
 *   /accept/<sid>    the host's side of one phone's session
 *   /healthz         "ok"
 */

export type RelayOptions = {
	port?: number;
	hostname?: string;
	tls?: { cert: string; key: string };
	/** Concurrent sockets from one IP address. */
	perIp?: number;
	/**
	 * Behind a TLS proxy (Caddy, a load balancer) every socket comes from the
	 * proxy: take the client's address from the last X-Forwarded-For entry,
	 * the one the proxy itself added. Only set it when a proxy is in front.
	 */
	trustProxy?: boolean;
	/** Bytes a session may forward in a minute, each way together. */
	bytesPerMinute?: number;
	/** Tests watch every forwarded message here - what any relay could log. */
	onForward?: (data: Uint8Array) => void;
};

type Role = "host" | "phone" | "accept";
type Socket = Bun.ServerWebSocket<{
	role: Role;
	key: string;
	ip: string;
	peer: Socket | null;
	window: { start: number; bytes: number };
}>;

/** One Noise message (65,535 bytes) and a little room; anything bigger isn't ours. */
const MAX_MESSAGE = 70_000;
/** How long a phone waits for its host to pick up. */
const ACCEPT_MS = 10_000;
/** A session ends after a day, as the channel's does. */
const SESSION_MS = 24 * 60 * 60 * 1000;
/** What a phone may send before its host picks up: the handshake, and a little. */
const BUFFER_MAX = 4;
const ID = /^[A-Za-z0-9_-]{22}$/;
const SID = /^[0-9a-f]{32}$/;

export function startRelay(
	options: RelayOptions = {},
): Bun.Server<Socket["data"]> {
	const perIp = options.perIp ?? 32;
	const bytesPerMinute = options.bytesPerMinute ?? 100 * 1024 * 1024;
	const hosts = new Map<string, Socket>();
	const pending = new Map<
		string,
		{
			phone: Socket;
			buffer: Uint8Array[];
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const perIpCount = new Map<string, number>();

	const join = (a: Socket, b: Socket) => {
		a.data.peer = b;
		b.data.peer = a;
		const end = setTimeout(() => a.close(1000, "Session over"), SESSION_MS);
		const clear = () => clearTimeout(end);
		// Either side closing ends both; see close() below.
		(a.data as { clear?: () => void }).clear = clear;
		(b.data as { clear?: () => void }).clear = clear;
	};

	const overBudget = (socket: Socket, size: number) => {
		const now = Date.now();
		const window = socket.data.window;
		if (now - window.start > 60_000) {
			window.start = now;
			window.bytes = 0;
		}
		window.bytes += size;
		return window.bytes > bytesPerMinute;
	};

	return Bun.serve<Socket["data"]>({
		port: options.port ?? 8443,
		hostname: options.hostname,
		tls: options.tls,
		fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === "/healthz") return new Response("ok");
			const [, role, key = ""] = url.pathname.split("/");
			const valid =
				(role === "host" || role === "connect"
					? ID.test(key)
					: role === "accept" && SID.test(key)) &&
				req.headers.get("upgrade")?.toLowerCase() === "websocket";
			if (!valid) return new Response("Not found", { status: 404 });
			const forwarded = options.trustProxy
				? req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
				: undefined;
			const ip = forwarded || server.requestIP(req)?.address || "?";
			if ((perIpCount.get(ip) ?? 0) >= perIp)
				return new Response("Too many connections", { status: 429 });
			const upgraded = server.upgrade(req, {
				data: {
					role: (role === "connect" ? "phone" : role) as Role,
					key,
					ip,
					peer: null,
					window: { start: Date.now(), bytes: 0 },
				},
			});
			return upgraded
				? undefined
				: new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			maxPayloadLength: MAX_MESSAGE,
			// Bun pings an idle socket; one that doesn't answer is closed.
			idleTimeout: 120,
			sendPings: true,
			open(ws) {
				perIpCount.set(ws.data.ip, (perIpCount.get(ws.data.ip) ?? 0) + 1);
				const { role, key } = ws.data;
				if (role === "host") {
					// The newest control connection wins: a host that reconnected
					// after sleep shouldn't wait out its own stale socket.
					hosts.get(key)?.close(4000, "Replaced");
					hosts.set(key, ws);
					return;
				}
				if (role === "phone") {
					const host = hosts.get(key);
					if (!host) return ws.close(4404, "No such host");
					const sid = crypto.randomUUID().replaceAll("-", "");
					ws.data.key = sid;
					pending.set(sid, {
						phone: ws,
						buffer: [],
						timer: setTimeout(
							() => ws.close(4408, "Host didn't answer"),
							ACCEPT_MS,
						),
					});
					host.send(JSON.stringify({ incoming: sid }));
					return;
				}
				const waiting = pending.get(key);
				if (!waiting) return ws.close(4404, "No such session");
				pending.delete(key);
				clearTimeout(waiting.timer);
				join(waiting.phone, ws);
				for (const data of waiting.buffer) {
					options.onForward?.(data);
					ws.send(data);
				}
			},
			message(ws, message) {
				if (ws.data.role === "host") return; // control: nothing to say
				// Binary only: a Noise message is never text.
				if (typeof message === "string") return ws.close(1003, "Binary only");
				const data = new Uint8Array(message);
				if (overBudget(ws, data.length)) return ws.close(4429, "Slow down");
				const peer = ws.data.peer;
				if (peer) {
					options.onForward?.(data);
					peer.send(data);
					return;
				}
				const waiting = pending.get(ws.data.key);
				if (!waiting || waiting.buffer.length >= BUFFER_MAX)
					return ws.close(4429, "Wait for the host");
				waiting.buffer.push(data);
			},
			close(ws) {
				const count = (perIpCount.get(ws.data.ip) ?? 1) - 1;
				if (count > 0) perIpCount.set(ws.data.ip, count);
				else perIpCount.delete(ws.data.ip);
				const { role, key, peer } = ws.data;
				if (role === "host" && hosts.get(key) === ws) hosts.delete(key);
				if (role === "phone") {
					const waiting = pending.get(key);
					if (waiting) {
						clearTimeout(waiting.timer);
						pending.delete(key);
					}
				}
				(ws.data as { clear?: () => void }).clear?.();
				if (peer) {
					peer.data.peer = null;
					peer.close(1000, "Other side left");
				}
			},
		},
	});
}
