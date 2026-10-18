import {
	Initiator,
	type KeyPair,
	open,
	Responder,
	seal,
	type Transport,
} from "./noise";

/**
 * The phone's requests to Odin, inside a Noise IK session (noise.ts): the
 * same method, path, headers and body as HTTP, cut into encrypted frames.
 * Whatever carries the bytes - a WebSocket on the Wi-Fi, a relay, a server's
 * public address - only ever sees ciphertext.
 *
 * On the wire, after the two handshake messages, every message is one sealed
 * frame: [kind: 1 byte][request id: 4 bytes][data].
 */

/** Anything that carries whole binary messages both ways: a WebSocket, a test pipe. */
export interface Pipe {
	send(data: Uint8Array): void;
	close(): void;
	onMessage(handler: (data: Uint8Array) => void): void;
	onClose(handler: () => void): void;
}

export type ChannelRequest = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: Uint8Array;
};

export type ChannelResponse = {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
};

/** What the phone says in its handshake: the protocol version, and on first use, its pairing code. */
export type Hello = { v: 1; code?: string; name?: string };

export const PROTOCOL_VERSION = 1;

const Kind = {
	requestHead: 1,
	requestBody: 2,
	requestEnd: 3,
	responseHead: 4,
	responseBody: 5,
	responseEnd: 6,
} as const;

/** Under Noise's 65,535-byte cap, with room for the tag and the frame header. */
export const CHUNK = 60_000;
/** A session ends after a day; the phone reconnects with fresh keys. */
export const SESSION_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(kind: number, id: number, data: Uint8Array = new Uint8Array(0)) {
	const out = new Uint8Array(5 + data.length);
	out[0] = kind;
	new DataView(out.buffer).setUint32(1, id);
	out.set(data, 5);
	return out;
}

function unframe(plaintext: Uint8Array) {
	if (plaintext.length < 5) throw new Error("Short frame");
	return {
		kind: plaintext[0],
		id: new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(1),
		data: plaintext.subarray(5),
	};
}

/** A head (JSON), the body in chunks, then an end marker. */
function* framesOf(
	head: number,
	body: number,
	end: number,
	id: number,
	meta: unknown,
	bytes: Uint8Array,
) {
	yield frame(head, id, encoder.encode(JSON.stringify(meta)));
	for (let at = 0; at < bytes.length; at += CHUNK)
		yield frame(body, id, bytes.subarray(at, at + CHUNK));
	yield frame(end, id);
}

const joined = (chunks: Uint8Array[]) => {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
};

/** Collects one message's head and body chunks until its end frame. */
class Assembly<Head> {
	head: Head | null = null;
	chunks: Uint8Array[] = [];
	body() {
		return joined(this.chunks);
	}
}

/**
 * The phone's side: handshake with the host whose key the QR code gave, then
 * send requests. Resolves once the host accepted the phone.
 */
export function connectChannel(
	pipe: Pipe,
	options: { me: KeyPair; host: Uint8Array; hello: Hello },
): Promise<{
	request(request: ChannelRequest): Promise<ChannelResponse>;
	close(): void;
	closed: Promise<void>;
}> {
	const initiator = new Initiator(options.me, options.host);
	let transport: Transport | null = null;
	let nextId = 1;
	const waiting = new Map<
		number,
		{
			assembly: Assembly<{ status: number; headers: Record<string, string> }>;
			resolve: (response: ChannelResponse) => void;
			reject: (error: Error) => void;
		}
	>();
	let markClosed: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		markClosed = resolve;
	});

	return new Promise((resolve, reject) => {
		const fail = (error: Error) => {
			reject(error);
			for (const call of waiting.values()) call.reject(error);
			waiting.clear();
			pipe.close();
		};
		pipe.onClose(() => {
			fail(new Error("The connection closed"));
			markClosed();
		});
		pipe.onMessage((data) => {
			try {
				if (!transport) {
					// Message 2: the host accepted us. A host that refused just closes.
					transport = initiator.readMessage2(data).transport;
					resolve({
						request: (request) =>
							new Promise((resolveCall, rejectCall) => {
								const id = nextId++;
								waiting.set(id, {
									assembly: new Assembly(),
									resolve: resolveCall,
									reject: rejectCall,
								});
								const { body, ...meta } = request;
								for (const plain of framesOf(
									Kind.requestHead,
									Kind.requestBody,
									Kind.requestEnd,
									id,
									meta,
									body,
								))
									pipe.send(seal(transport as Transport, plain));
							}),
						close: () => pipe.close(),
						closed,
					});
					return;
				}
				const { kind, id, data: part } = unframe(open(transport, data));
				const call = waiting.get(id);
				if (!call) return;
				if (kind === Kind.responseHead)
					call.assembly.head = JSON.parse(decoder.decode(part));
				else if (kind === Kind.responseBody)
					call.assembly.chunks.push(part.slice());
				else if (kind === Kind.responseEnd) {
					waiting.delete(id);
					const head = call.assembly.head ?? { status: 502, headers: {} };
					call.resolve({ ...head, body: call.assembly.body() });
				}
			} catch (error) {
				// A failed tag means the bytes were changed: end the whole session.
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		pipe.send(
			initiator.writeMessage1(encoder.encode(JSON.stringify(options.hello))),
		);
	});
}

/**
 * The host's side: read the phone's handshake, let `accept` decide (is this
 * phone trusted, or is its pairing code good?), then answer its requests
 * with `handle`. A refused phone gets no message 2 - the pipe just closes.
 */
export function acceptChannel(
	pipe: Pipe,
	options: {
		me: KeyPair;
		accept: (phone: Uint8Array, hello: Hello) => boolean | Promise<boolean>;
		handle: (
			request: ChannelRequest,
			phone: Uint8Array,
		) => Promise<ChannelResponse>;
	},
): void {
	const responder = new Responder(options.me);
	let transport: Transport | null = null;
	let phone: Uint8Array | null = null;
	let handshaking = false;
	const incoming = new Map<
		number,
		Assembly<{ method: string; path: string; headers: Record<string, string> }>
	>();
	const expiry = setTimeout(() => pipe.close(), SESSION_MS);
	pipe.onClose(() => clearTimeout(expiry));

	const reply = (id: number, response: ChannelResponse) => {
		if (!transport) return;
		const { body, ...meta } = response;
		for (const plain of framesOf(
			Kind.responseHead,
			Kind.responseBody,
			Kind.responseEnd,
			id,
			meta,
			body,
		))
			pipe.send(seal(transport, plain));
	};

	pipe.onMessage(async (data) => {
		try {
			if (!transport) {
				if (handshaking) return pipe.close(); // nothing may jump the handshake
				handshaking = true;
				const first = responder.readMessage1(data);
				const hello = JSON.parse(decoder.decode(first.payload)) as Hello;
				if (hello.v !== PROTOCOL_VERSION) return pipe.close();
				if (!(await options.accept(first.remoteStatic, hello)))
					return pipe.close();
				phone = first.remoteStatic;
				const done = responder.writeMessage2(
					encoder.encode(JSON.stringify({ v: PROTOCOL_VERSION })),
				);
				transport = done.transport;
				pipe.send(done.message);
				return;
			}
			const { kind, id, data: part } = unframe(open(transport, data));
			let assembly = incoming.get(id);
			if (kind === Kind.requestHead) {
				assembly = new Assembly();
				assembly.head = JSON.parse(decoder.decode(part));
				incoming.set(id, assembly);
			} else if (kind === Kind.requestBody) assembly?.chunks.push(part.slice());
			else if (kind === Kind.requestEnd && assembly?.head && phone) {
				incoming.delete(id);
				const request = { ...assembly.head, body: assembly.body() };
				const response = await options.handle(request, phone).catch(
					(): ChannelResponse => ({
						status: 500,
						headers: {},
						body: new Uint8Array(0),
					}),
				);
				reply(id, response);
			}
		} catch {
			// Undecryptable or malformed: whoever sent it isn't our phone.
			pipe.close();
		}
	});
}
