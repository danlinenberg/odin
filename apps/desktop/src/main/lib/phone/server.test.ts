import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectChannel,
	connectSocket,
	generateKeyPair,
	relayId,
	websocketPipe,
} from "@odin/channel";
import { startRelay } from "@odin/relay";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";

// The gate is under test, not the board: a stand-in router.
const t = initTRPC.create({ transformer: superjson });
mock.module("./router", () => ({
	phoneRouter: t.router({ board: t.procedure.query(() => "ok") }),
}));
const {
	phoneConfig,
	phoneStatus,
	removePhone,
	setPhoneEnabled,
	setPhoneRelay,
} = await import("./server");
const { attachments } = await import("./attachments");
const { trustFiles } = await import("./trust");
// Not ~/.odin, and not by mocking app-environment: a module mock leaks into
// every later test file in the run.
const dir = mkdtempSync(join(tmpdir(), "odin-phone-"));
attachments.dir = join(dir, "attachments");
phoneConfig.file = join(dir, "phone.json");
trustFiles.identity = join(dir, "phone-identity");
trustFiles.devices = join(dir, "phone-devices.json");

const relay = startRelay({ port: 0, hostname: "127.0.0.1" });
afterAll(async () => {
	await setPhoneEnabled(false);
	void relay.stop(true);
});

const me = generateKeyPair();

async function on() {
	const status = await setPhoneEnabled(true);
	if (status.state !== "on") throw new Error(JSON.stringify(status));
	return new URL(status.link).searchParams;
}

const lan = (pair: URLSearchParams) =>
	(pair.get("l") ?? "").replace(/\/\/[^:/]+:/, "//127.0.0.1:");

async function channel(url: string, pair: URLSearchParams, code?: string) {
	return connectChannel(websocketPipe(await connectSocket(url)), {
		me,
		host: Uint8Array.from(Buffer.from(pair.get("k") ?? "", "base64url")),
		hello: { v: 1, code, name: "Test iPhone" },
	});
}

test("a phone without the pairing code gets no channel", async () => {
	const pair = await on();
	expect(channel(lan(pair), pair)).rejects.toThrow();
	expect(channel(lan(pair), pair, "wrong")).rejects.toThrow();
});

test("the QR code's code pairs the phone; then its requests reach the API", async () => {
	const pair = await on();
	const paired = await channel(lan(pair), pair, pair.get("c") ?? "");
	const board = await paired.request({
		method: "GET",
		path: "/trpc/board",
		headers: {},
		body: new Uint8Array(0),
	});
	expect(board.status).toBe(200);
	expect(new TextDecoder().decode(board.body)).toContain("ok");
	paired.close();

	// Paired now: no code needed, and only the API's routes answer.
	const again = await channel(lan(pair), pair);
	const other = await again.request({
		method: "GET",
		path: "/anything",
		headers: {},
		body: new Uint8Array(0),
	});
	expect(other.status).toBe(404);
	again.close();
});

test("an upload through the channel lands in the attachments folder", async () => {
	const pair = await on();
	const paired = await channel(lan(pair), pair);
	const saved = await paired.request({
		method: "POST",
		path: "/upload?ext=JPG",
		headers: { "content-type": "image/jpeg" },
		body: new Uint8Array([1, 2, 3]),
	});
	const { path } = JSON.parse(new TextDecoder().decode(saved.body));
	expect(path.startsWith(attachments.dir)).toBe(true);
	expect([...readFileSync(path)]).toEqual([1, 2, 3]);
	paired.close();
});

test("the Wi-Fi port answers nothing but the channel", async () => {
	const pair = await on();
	const http = lan(pair).replace("ws://", "http://").replace("/channel", "");
	expect((await fetch(`${http}/trpc/board`)).status).toBe(404);
});

test("from anywhere: the same channel through a relay", async () => {
	const base = `ws://127.0.0.1:${relay.port}`;
	expect(setPhoneRelay("http://relay.example.com")).rejects.toThrow();
	await setPhoneRelay(base);
	const pair = await on();
	expect(pair.get("r")).toBe(base);
	// Odin dials the relay; wait for its control connection.
	for (let i = 0; i < 50; i++) {
		const status = await phoneStatus();
		if (status.state === "on" && status.relayState === "connected") break;
		await Bun.sleep(20);
	}
	const host = Uint8Array.from(Buffer.from(pair.get("k") ?? "", "base64url"));
	const paired = await channel(`${base}/connect/${relayId(host)}`, pair);
	const board = await paired.request({
		method: "GET",
		path: "/trpc/board",
		headers: {},
		body: new Uint8Array(0),
	});
	expect(board.status).toBe(200);

	// Removing the phone cuts it off at once, and it can't come back.
	await removePhone(Buffer.from(me.publicKey).toString("base64url"));
	await paired.closed;
	expect(channel(lan(pair), pair)).rejects.toThrow();
	await setPhoneRelay("");
});
