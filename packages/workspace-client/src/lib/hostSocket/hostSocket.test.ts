import { afterEach, describe, expect, it } from "bun:test";
import { createHostSocket, type HostSocket } from "./hostSocket";

function makeServer() {
	const tokensSeen: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			tokensSeen.push(url.searchParams.get("token") ?? "");
			if (srv.upgrade(req)) return;
			return new Response("no", { status: 400 });
		},
		websocket: {
			open(ws) {
				ws.send("hello");
			},
			message() {},
		},
	});
	return { server, tokensSeen, port: server.port };
}

let socket: HostSocket | null = null;

afterEach(() => {
	socket?.close();
	socket = null;
});

function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const t = setInterval(() => {
			if (cond()) {
				clearInterval(t);
				resolve();
			} else if (Date.now() - start > timeoutMs) {
				clearInterval(t);
				reject(new Error("waitFor timeout"));
			}
		}, 20);
	});
}

describe("createHostSocket", () => {
	it("signs every attempt with a fresh token", async () => {
		const { server, tokensSeen, port } = makeServer();
		let tokenVersion = 0;
		socket = createHostSocket({
			buildUrl: () => `ws://localhost:${port}/events`,
			getToken: () => `tok-${++tokenVersion}`,
			minReconnectionDelay: 20,
			maxReconnectionDelay: 40,
		});
		await waitFor(() => tokensSeen.length >= 1);
		// Force a reconnect; the next dial must carry a NEW token.
		socket.reconnect();
		await waitFor(() => tokensSeen.length >= 2);
		expect(tokensSeen[0]).toBe("tok-1");
		expect(tokensSeen[1]).not.toBe(tokensSeen[0]);
		server.stop(true);
	});

	it("converts an http host URL to ws", async () => {
		const { server, tokensSeen, port } = makeServer();
		socket = createHostSocket({
			buildUrl: () => `http://localhost:${port}/events`,
			getToken: () => "psk-1",
			minReconnectionDelay: 20,
			maxReconnectionDelay: 40,
		});
		await waitFor(() => tokensSeen.length >= 1);
		expect(tokensSeen[0]).toBe("psk-1");
		server.stop(true);
	});
});
