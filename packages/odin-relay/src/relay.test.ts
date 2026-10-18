import { afterAll, expect, test } from "bun:test";
import {
	acceptChannel,
	connectChannel,
	connectSocket,
	generateKeyPair,
	relayId,
	websocketPipe,
} from "@odin/channel";
import { startRelay } from "./relay";

const forwarded: Uint8Array[] = [];
const relay = startRelay({
	port: 0,
	hostname: "127.0.0.1",
	perIp: 6,
	onForward: (data) => forwarded.push(data.slice()),
});
const base = `ws://127.0.0.1:${relay.port}`;
afterAll(() => {
	// Not awaited: it waits out sockets the tests already let go of.
	void relay.stop(true);
});

const text = new TextEncoder();
const host = generateKeyPair();
const phone = generateKeyPair();
const id = relayId(host.publicKey);

/** An Odin host on the relay: one control socket, a channel per phone. */
async function serveHost() {
	const control = await connectSocket(`${base}/host/${id}`);
	control.addEventListener("message", async (event) => {
		const { incoming } = JSON.parse(String(event.data));
		const socket = await connectSocket(`${base}/accept/${incoming}`);
		acceptChannel(websocketPipe(socket), {
			me: host,
			accept: () => true,
			handle: async (request) => ({
				status: 200,
				headers: {},
				body: text.encode(
					`odin got ${request.method} ${request.path}: ${new TextDecoder().decode(request.body)}`,
				),
			}),
		});
	});
	return control;
}

const closeCode = (socket: WebSocket) =>
	new Promise<number>((resolve) =>
		socket.addEventListener("close", (event) => resolve(event.code)),
	);

test("a phone reaches its Odin through the relay, which sees no plaintext", async () => {
	const control = await serveHost();
	const socket = await connectSocket(`${base}/connect/${id}`);
	const channel = await connectChannel(websocketPipe(socket), {
		me: phone,
		host: host.publicKey,
		hello: { v: 1, code: "pairing-code-0123456789" },
	});
	const secret = "the deploy key is AKIA-SECRET-42";
	const answer = await channel.request({
		method: "POST",
		path: "/trpc/reply",
		headers: { authorization: "never-in-clear" },
		body: text.encode(secret),
	});
	expect(new TextDecoder().decode(answer.body)).toBe(
		`odin got POST /trpc/reply: ${secret}`,
	);

	// Everything the relay forwarded, as one string: what its operator could log.
	const logged = Buffer.concat(forwarded.map((b) => Buffer.from(b))).toString(
		"latin1",
	);
	expect(forwarded.length).toBeGreaterThan(3);
	for (const plaintext of [
		secret,
		"odin got",
		"pairing-code-0123456789",
		"/trpc/reply",
		"never-in-clear",
	])
		expect(logged.includes(plaintext)).toBe(false);
	channel.close();
	control.close();
});

test("a phone asking for a host that isn't there is turned away", async () => {
	const socket = new WebSocket(
		`${base}/connect/${relayId(generateKeyPair().publicKey)}`,
	);
	expect(await closeCode(socket)).toBe(4404);
});

test("text messages are refused: a Noise message is always binary", async () => {
	const control = await serveHost();
	const socket = await connectSocket(`${base}/connect/${id}`);
	const code = closeCode(socket);
	socket.send("plaintext please");
	expect(await code).toBe(1003);
	control.close();
});

test("one address can't hold more than its share of connections", async () => {
	const sockets = await Promise.allSettled(
		Array.from({ length: 8 }, () =>
			connectSocket(`${base}/host/${relayId(generateKeyPair().publicKey)}`),
		),
	);
	const refused = sockets.filter((s) => s.status === "rejected").length;
	expect(refused).toBeGreaterThanOrEqual(2);
	for (const s of sockets) if (s.status === "fulfilled") s.value.close();
});

test("behind a proxy, the limit counts each client, not the proxy", async () => {
	const proxied = startRelay({
		port: 0,
		hostname: "127.0.0.1",
		perIp: 1,
		trustProxy: true,
	});
	const open = (client: string) =>
		new Promise<boolean>((resolve) => {
			const socket = new WebSocket(
				`ws://127.0.0.1:${proxied.port}/host/${relayId(generateKeyPair().publicKey)}`,
				{ headers: { "x-forwarded-for": `9.9.9.9, ${client}` } },
			);
			socket.addEventListener("open", () => resolve(true));
			socket.addEventListener("error", () => resolve(false));
		});
	expect(await open("1.1.1.1")).toBe(true);
	expect(await open("2.2.2.2")).toBe(true);
	expect(await open("1.1.1.1")).toBe(false);
	void proxied.stop(true);
});

test("anything but the three routes is a 404", async () => {
	const response = await fetch(
		`http://127.0.0.1:${relay.port}/connect/not-an-id`,
	);
	expect(response.status).toBe(404);
	expect(
		await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).text(),
	).toBe("ok");
});
