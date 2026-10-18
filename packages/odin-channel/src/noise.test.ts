import { describe, expect, test } from "bun:test";
import {
	generateKeyPair,
	Initiator,
	keyPairFrom,
	open,
	PROTOCOL_NAME,
	Responder,
	seal,
	type Transport,
} from "./noise";
import vectorsFile from "./noise-vectors.json";

const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

type Vector = {
	protocol_name: string;
	init_prologue: string;
	init_static: string;
	init_ephemeral: string;
	init_remote_static: string;
	resp_prologue: string;
	resp_static: string;
	resp_ephemeral: string;
	handshake_hash: string;
	messages: { payload: string; ciphertext: string }[];
};

describe("the official test vectors (Cacophony)", () => {
	const vectors = vectorsFile.vectors as Vector[];

	test("there is one for exactly this protocol", () => {
		expect(vectors.length).toBeGreaterThan(0);
		for (const v of vectors) expect(v.protocol_name).toBe(PROTOCOL_NAME);
	});

	for (const [index, v] of vectors.entries())
		test(`vector ${index}: every byte of the handshake and transport`, () => {
			const initiator = new Initiator(
				keyPairFrom(hex(v.init_static)),
				hex(v.init_remote_static),
				{
					prologue: hex(v.init_prologue),
					ephemeral: keyPairFrom(hex(v.init_ephemeral)),
				},
			);
			const responder = new Responder(keyPairFrom(hex(v.resp_static)), {
				prologue: hex(v.resp_prologue),
				ephemeral: keyPairFrom(hex(v.resp_ephemeral)),
			});
			const [m1, m2, ...rest] = v.messages;
			if (!m1 || !m2) throw new Error("vector has no handshake");

			const message1 = initiator.writeMessage1(hex(m1.payload));
			expect(toHex(message1)).toBe(m1.ciphertext);
			expect(toHex(responder.readMessage1(message1).payload)).toBe(m1.payload);

			const reply = responder.writeMessage2(hex(m2.payload));
			expect(toHex(reply.message)).toBe(m2.ciphertext);
			const done = initiator.readMessage2(reply.message);
			expect(toHex(done.payload)).toBe(m2.payload);

			expect(toHex(done.transport.handshakeHash)).toBe(v.handshake_hash);
			expect(toHex(reply.transport.handshakeHash)).toBe(v.handshake_hash);

			// After the handshake the vectors alternate: initiator, responder, ...
			for (const [i, m] of rest.entries()) {
				const [from, to]: Transport[] =
					i % 2 === 0
						? [done.transport, reply.transport]
						: [reply.transport, done.transport];
				const sealed = seal(from, hex(m.payload));
				expect(toHex(sealed)).toBe(m.ciphertext);
				expect(toHex(open(to, sealed))).toBe(m.payload);
			}
		});
});

describe("what must fail", () => {
	const host = generateKeyPair();
	const phone = generateKeyPair();
	const text = new TextEncoder();

	test("a phone holding the wrong host key can't complete the handshake", () => {
		const impostor = generateKeyPair();
		// The phone thinks `impostor` is the host; the real host can't read it.
		const message1 = new Initiator(phone, impostor.publicKey).writeMessage1(
			text.encode("hi"),
		);
		expect(() => new Responder(host).readMessage1(message1)).toThrow();
	});

	test("a relay that pretends to be the host can't answer", () => {
		const relay = generateKeyPair();
		const initiator = new Initiator(phone, host.publicKey);
		const message1 = initiator.writeMessage1(text.encode("hi"));
		// The relay can't read message 1 with its own key...
		expect(() => new Responder(relay).readMessage1(message1)).toThrow();
	});

	test("one changed byte in transit fails", () => {
		const initiator = new Initiator(phone, host.publicKey);
		const responder = new Responder(host);
		responder.readMessage1(initiator.writeMessage1(new Uint8Array(0)));
		const reply = responder.writeMessage2(new Uint8Array(0));
		const { transport } = initiator.readMessage2(reply.message);
		const sealed = seal(transport, text.encode("GET /trpc/board"));
		sealed[5] = (sealed[5] ?? 0) ^ 1;
		expect(() => open(reply.transport, sealed)).toThrow();
	});

	test("a replayed message fails", () => {
		const initiator = new Initiator(phone, host.publicKey);
		const responder = new Responder(host);
		responder.readMessage1(initiator.writeMessage1(new Uint8Array(0)));
		const reply = responder.writeMessage2(new Uint8Array(0));
		const { transport } = initiator.readMessage2(reply.message);
		const sealed = seal(transport, text.encode("reply: yes"));
		expect(new TextDecoder().decode(open(reply.transport, sealed))).toBe(
			"reply: yes",
		);
		expect(() => open(reply.transport, sealed)).toThrow();
	});

	test("the host learns the phone's real key, and nothing else claims it", () => {
		const initiator = new Initiator(phone, host.publicKey);
		const { remoteStatic } = new Responder(host).readMessage1(
			initiator.writeMessage1(new Uint8Array(0)),
		);
		expect(toHex(remoteStatic)).toBe(toHex(phone.publicKey));
	});
});
