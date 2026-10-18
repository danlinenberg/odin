import { describe, expect, test } from "bun:test";
import {
	acceptChannel,
	type ChannelRequest,
	connectChannel,
	type Pipe,
} from "./channel";
import { generateKeyPair } from "./noise";

/**
 * Two pipe ends joined through a "relay" that records every byte it
 * forwards, the way a real relay could.
 */
function relayedPipes() {
	const seen: Uint8Array[] = [];
	const make = () => {
		const handlers: ((data: Uint8Array) => void)[] = [];
		const closers: (() => void)[] = [];
		let other: ReturnType<typeof make> | null = null;
		let open = true;
		const pipe: Pipe & {
			deliver: (data: Uint8Array) => void;
			shut: () => void;
			link: (o: ReturnType<typeof make>) => void;
		} = {
			send: (data) => {
				seen.push(data.slice());
				queueMicrotask(() => other?.deliver(data));
			},
			close: () => {
				if (!open) return;
				pipe.shut();
				other?.shut();
			},
			onMessage: (handler) => handlers.push(handler),
			onClose: (handler) => closers.push(handler),
			deliver: (data) => {
				if (open) for (const handler of handlers) handler(data);
			},
			shut: () => {
				if (!open) return;
				open = false;
				for (const closer of closers) closer();
			},
			link: (o) => {
				other = o;
			},
		};
		return pipe;
	};
	const phoneEnd = make();
	const hostEnd = make();
	phoneEnd.link(hostEnd);
	hostEnd.link(phoneEnd);
	return { phoneEnd, hostEnd, seen };
}

const text = new TextEncoder();
const host = generateKeyPair();
const phone = generateKeyPair();

/** A host that echoes what it got, so a test can see what arrived. */
function echoHost(pipe: Pipe, accept = true) {
	acceptChannel(pipe, {
		me: host,
		accept: () => accept,
		handle: async (request: ChannelRequest) => ({
			status: 200,
			headers: { "content-type": "application/octet-stream" },
			body: text.encode(
				JSON.stringify({
					method: request.method,
					path: request.path,
					bytes: request.body.length,
					last: request.body.at(-1) ?? null,
				}),
			),
		}),
	});
}

describe("the channel", () => {
	test("a request goes in, the answer comes back", async () => {
		const { phoneEnd, hostEnd } = relayedPipes();
		echoHost(hostEnd);
		const channel = await connectChannel(phoneEnd, {
			me: phone,
			host: host.publicKey,
			hello: { v: 1 },
		});
		const answer = await channel.request({
			method: "GET",
			path: "/trpc/board",
			headers: {},
			body: new Uint8Array(0),
		});
		expect(answer.status).toBe(200);
		expect(JSON.parse(new TextDecoder().decode(answer.body))).toEqual({
			method: "GET",
			path: "/trpc/board",
			bytes: 0,
			last: null,
		});
	});

	test("a 250 KB upload arrives whole, across frames", async () => {
		const { phoneEnd, hostEnd } = relayedPipes();
		echoHost(hostEnd);
		const channel = await connectChannel(phoneEnd, {
			me: phone,
			host: host.publicKey,
			hello: { v: 1 },
		});
		const body = new Uint8Array(250_000).fill(7);
		body[body.length - 1] = 42;
		const answer = await channel.request({
			method: "POST",
			path: "/upload?ext=jpg",
			headers: {},
			body,
		});
		const got = JSON.parse(new TextDecoder().decode(answer.body));
		expect(got.bytes).toBe(250_000);
		expect(got.last).toBe(42);
	});

	test("requests at the same time each get their own answer", async () => {
		const { phoneEnd, hostEnd } = relayedPipes();
		echoHost(hostEnd);
		const channel = await connectChannel(phoneEnd, {
			me: phone,
			host: host.publicKey,
			hello: { v: 1 },
		});
		const paths = ["/trpc/board", "/trpc/session", "/trpc/brief"];
		const answers = await Promise.all(
			paths.map((path) =>
				channel.request({
					method: "GET",
					path,
					headers: {},
					body: new Uint8Array(0),
				}),
			),
		);
		expect(
			answers.map((a) => JSON.parse(new TextDecoder().decode(a.body)).path),
		).toEqual(paths);
	});

	test("a phone the host refuses gets no answer - the pipe closes", async () => {
		const { phoneEnd, hostEnd } = relayedPipes();
		echoHost(hostEnd, false);
		expect(
			connectChannel(phoneEnd, {
				me: phone,
				host: host.publicKey,
				hello: { v: 1 },
			}),
		).rejects.toThrow("The connection closed");
	});

	test("the host sees the pairing code the phone sent, and who sent it", async () => {
		const { phoneEnd, hostEnd } = relayedPipes();
		let heard: { code?: string; phone?: string } = {};
		acceptChannel(hostEnd, {
			me: host,
			accept: (key, hello) => {
				heard = { code: hello.code, phone: Buffer.from(key).toString("hex") };
				return true;
			},
			handle: async () => ({
				status: 204,
				headers: {},
				body: new Uint8Array(0),
			}),
		});
		await connectChannel(phoneEnd, {
			me: phone,
			host: host.publicKey,
			hello: { v: 1, code: "one-time-code" },
		});
		expect(heard).toEqual({
			code: "one-time-code",
			phone: Buffer.from(phone.publicKey).toString("hex"),
		});
	});

	test("the relay in the middle never sees any of the plaintext", async () => {
		const { phoneEnd, hostEnd, seen } = relayedPipes();
		echoHost(hostEnd);
		const channel = await connectChannel(phoneEnd, {
			me: phone,
			host: host.publicKey,
			hello: { v: 1, code: "secret-pairing-code-1234" },
		});
		const secret = "SECRET-SESSION-TEXT: deploy key AKIAABCDEFGH";
		await channel.request({
			method: "POST",
			path: "/trpc/reply",
			headers: { authorization: "never-sent-in-clear" },
			body: text.encode(secret),
		});
		const everything = Buffer.concat(seen.map((b) => Buffer.from(b))).toString(
			"latin1",
		);
		for (const plaintext of [
			secret,
			"secret-pairing-code-1234",
			"/trpc/reply",
			"never-sent-in-clear",
			"POST",
		])
			expect(everything.includes(plaintext)).toBe(false);
		// And the phone's long-term key never crosses in clear either.
		expect(
			everything.includes(Buffer.from(phone.publicKey).toString("latin1")),
		).toBe(false);
	});
});
