import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2s } from "@noble/hashes/blake2.js";
import { hmac } from "@noble/hashes/hmac.js";

/**
 * Noise_IK_25519_ChaChaPoly_BLAKE2s, written to the Noise Protocol Framework
 * specification, revision 34 (https://noiseprotocol.org/noise.html). Section
 * numbers below refer to it. Checked against the official test vectors
 * (noise.test.ts). Primitives only from the audited @noble libraries.
 *
 *   IK:
 *     <- s
 *     ...
 *     -> e, es, s, ss
 *     <- e, ee, se
 */

export const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

const DHLEN = 32;
const HASHLEN = 32;
/** 5.2: the AEAD tag. */
const TAGLEN = 16;
/** 3: no Noise message is longer. */
export const MAX_MESSAGE = 65_535;

export type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

export function generateKeyPair(): KeyPair {
	const privateKey = x25519.utils.randomSecretKey();
	return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** A key pair from a stored private key (and the test vectors' fixed keys). */
export const keyPairFrom = (privateKey: Uint8Array): KeyPair => ({
	privateKey,
	publicKey: x25519.getPublicKey(privateKey),
});

/** 4.1: DH(key_pair, public_key). */
const dh = (pair: KeyPair, publicKey: Uint8Array) =>
	x25519.getSharedSecret(pair.privateKey, publicKey);

const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/** 4.2 (ChaChaPoly): 32 bits of zeros, then the 64-bit counter little-endian. */
function nonce(n: bigint): Uint8Array {
	const out = new Uint8Array(12);
	new DataView(out.buffer).setBigUint64(4, n, true);
	return out;
}

/** 4.3: HMAC-HASH and HKDF with BLAKE2s. */
const hash = (data: Uint8Array) => blake2s(data);
const hmacHash = (key: Uint8Array, data: Uint8Array) =>
	hmac(blake2s, key, data);
function hkdf2(chainingKey: Uint8Array, input: Uint8Array) {
	const tempKey = hmacHash(chainingKey, input);
	const out1 = hmacHash(tempKey, Uint8Array.of(1));
	const out2 = hmacHash(tempKey, concat(out1, Uint8Array.of(2)));
	return [out1, out2] as const;
}

/** 5.1: a key and its nonce counter. */
export class CipherState {
	private n = 0n;
	constructor(private k: Uint8Array | null = null) {}

	hasKey() {
		return this.k !== null;
	}

	encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
		if (!this.k) return plaintext;
		// 5.1: 2^64-1 is reserved; a session never gets near it (24h cap).
		if (this.n >= 0xffffffffffffffffn) throw new Error("Nonce exhausted");
		const out = chacha20poly1305(this.k, nonce(this.n), ad).encrypt(plaintext);
		this.n += 1n;
		return out;
	}

	decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
		if (!this.k) return ciphertext;
		if (this.n >= 0xffffffffffffffffn) throw new Error("Nonce exhausted");
		// Throws on a bad tag; the nonce only moves on success (5.1).
		const out = chacha20poly1305(this.k, nonce(this.n), ad).decrypt(ciphertext);
		this.n += 1n;
		return out;
	}
}

/** 5.2: the handshake's running hash and chaining key. */
class SymmetricState {
	private ck: Uint8Array;
	h: Uint8Array;
	private cipher = new CipherState();

	constructor(protocolName: string) {
		const name = new TextEncoder().encode(protocolName);
		this.h =
			name.length <= HASHLEN
				? concat(name, new Uint8Array(HASHLEN - name.length))
				: hash(name);
		this.ck = this.h;
	}

	mixKey(input: Uint8Array) {
		const [ck, tempK] = hkdf2(this.ck, input);
		this.ck = ck;
		this.cipher = new CipherState(tempK.slice(0, 32));
	}

	mixHash(data: Uint8Array) {
		this.h = hash(concat(this.h, data));
	}

	encryptAndHash(plaintext: Uint8Array) {
		const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
		this.mixHash(ciphertext);
		return ciphertext;
	}

	decryptAndHash(ciphertext: Uint8Array) {
		const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
		this.mixHash(ciphertext);
		return plaintext;
	}

	split(): [CipherState, CipherState] {
		const [k1, k2] = hkdf2(this.ck, new Uint8Array(0));
		return [new CipherState(k1.slice(0, 32)), new CipherState(k2.slice(0, 32))];
	}
}

/** After the handshake: one key each way, and the handshake hash. */
export type Transport = {
	send: CipherState;
	receive: CipherState;
	handshakeHash: Uint8Array;
	/** The other side's static public key, as proven by the handshake. */
	remoteStatic: Uint8Array;
};

type Options = {
	prologue?: Uint8Array;
	/** The test vectors' fixed ephemeral key; never set outside tests. */
	ephemeral?: KeyPair;
};

/**
 * The phone's side. It knows the host's static key from the QR code, so the
 * host can't be impersonated: a wrong key fails at the first `es`/`ss`.
 */
export class Initiator {
	private ss: SymmetricState;
	private e: KeyPair | null = null;

	constructor(
		private s: KeyPair,
		private rs: Uint8Array,
		private options: Options = {},
	) {
		this.ss = new SymmetricState(PROTOCOL_NAME);
		this.ss.mixHash(options.prologue ?? new Uint8Array(0));
		this.ss.mixHash(rs); // pre-message: <- s
	}

	/** -> e, es, s, ss, then the payload. */
	writeMessage1(payload: Uint8Array): Uint8Array {
		const e = this.options.ephemeral ?? generateKeyPair();
		this.e = e;
		this.ss.mixHash(e.publicKey);
		this.ss.mixKey(dh(e, this.rs));
		const s = this.ss.encryptAndHash(this.s.publicKey);
		this.ss.mixKey(dh(this.s, this.rs));
		const body = this.ss.encryptAndHash(payload);
		return checked(concat(e.publicKey, s, body));
	}

	/** <- e, ee, se, then the payload; the handshake ends here. */
	readMessage2(message: Uint8Array): {
		payload: Uint8Array;
		transport: Transport;
	} {
		if (!this.e) throw new Error("Message 1 first");
		if (message.length < DHLEN + TAGLEN) throw new Error("Short message");
		const re = message.subarray(0, DHLEN);
		this.ss.mixHash(re);
		this.ss.mixKey(dh(this.e, re));
		this.ss.mixKey(dh(this.s, re));
		const payload = this.ss.decryptAndHash(message.subarray(DHLEN));
		const [send, receive] = this.ss.split();
		return {
			payload,
			transport: {
				send,
				receive,
				handshakeHash: this.ss.h,
				remoteStatic: this.rs,
			},
		};
	}
}

/** The host's side. It learns the phone's static key from message 1, encrypted. */
export class Responder {
	private ss: SymmetricState;
	private re: Uint8Array | null = null;
	private rs: Uint8Array | null = null;

	constructor(
		private s: KeyPair,
		private options: Options = {},
	) {
		this.ss = new SymmetricState(PROTOCOL_NAME);
		this.ss.mixHash(options.prologue ?? new Uint8Array(0));
		this.ss.mixHash(s.publicKey); // pre-message: <- s
	}

	/** Reads -> e, es, s, ss and the payload; `remoteStatic` is who's asking. */
	readMessage1(message: Uint8Array): {
		payload: Uint8Array;
		remoteStatic: Uint8Array;
	} {
		// e (32) + encrypted s (32 + 16) + at least the payload's tag (16).
		if (message.length < DHLEN + DHLEN + TAGLEN + TAGLEN)
			throw new Error("Short message");
		const re = message.subarray(0, DHLEN);
		this.re = re;
		this.ss.mixHash(re);
		this.ss.mixKey(dh(this.s, re));
		const rs = this.ss.decryptAndHash(
			message.subarray(DHLEN, DHLEN + DHLEN + TAGLEN),
		);
		this.rs = rs;
		this.ss.mixKey(dh(this.s, rs));
		const payload = this.ss.decryptAndHash(
			message.subarray(DHLEN + DHLEN + TAGLEN),
		);
		return { payload, remoteStatic: rs };
	}

	/** <- e, ee, se, then the payload; the handshake ends here. */
	writeMessage2(payload: Uint8Array): {
		message: Uint8Array;
		transport: Transport;
	} {
		if (!this.re || !this.rs) throw new Error("Message 1 first");
		const e = this.options.ephemeral ?? generateKeyPair();
		this.ss.mixHash(e.publicKey);
		this.ss.mixKey(dh(e, this.re));
		this.ss.mixKey(dh(e, this.rs));
		const body = this.ss.encryptAndHash(payload);
		const [receive, send] = this.ss.split();
		return {
			message: checked(concat(e.publicKey, body)),
			transport: {
				send,
				receive,
				handshakeHash: this.ss.h,
				remoteStatic: this.rs,
			},
		};
	}
}

function checked(message: Uint8Array): Uint8Array {
	if (message.length > MAX_MESSAGE) throw new Error("Message too long");
	return message;
}

/** Transport messages: no associated data (5.1). */
export const seal = (transport: Transport, plaintext: Uint8Array) =>
	checked(transport.send.encryptWithAd(new Uint8Array(0), plaintext));
export const open = (transport: Transport, ciphertext: Uint8Array) =>
	transport.receive.decryptWithAd(new Uint8Array(0), ciphertext);
