import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	generateKeyPair,
	type Hello,
	type KeyPair,
	keyPairFrom,
} from "@odin/channel";
import { ODIN_HOME_DIR } from "../app-environment";
import type { PushTarget } from "./apns";

/**
 * Who may talk to Odin from a phone (docs/phone-encryption.md): Odin's own
 * key, the phones it trusts, and the one-time code the QR code carries.
 */

export type Device = {
	key: string;
	name: string;
	added: string;
	/** Where its lock screen widget's silent pushes go (apns.ts), once it sent one. */
	push?: PushTarget;
};

/** A pairing code lasts 10 minutes and pairs one phone. */
export const CODE_MS = 10 * 60 * 1000;

/**
 * Where a host keeps them. `code` is set where the code is made by one
 * process and checked by another (the phone server on a remote host, whose
 * pairing link a separate `link` run prints): the code then lives in that
 * file, mode 0600, instead of in memory.
 */
export type TrustFiles = { identity: string; devices: string; code?: string };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const sameCode = (given: string, expected: string) => {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
};

/** One host's trust: its key, its phones, its pairing code. Paths are read at each call. */
export function createTrust(files: TrustFiles) {
	let me: { path: string; pair: KeyPair } | null = null;
	let memoryCode: { value: string; expires: number } | null = null;

	const readCode = (): { value: string; expires: number } | null => {
		if (!files.code) return memoryCode;
		try {
			const saved = JSON.parse(readFileSync(files.code, "utf8"));
			return typeof saved?.value === "string" &&
				typeof saved.expires === "number"
				? saved
				: null;
		} catch {
			return null;
		}
	};
	const writeCode = (next: { value: string; expires: number } | null) => {
		if (!files.code) {
			memoryCode = next;
			return;
		}
		if (next) writeFileSync(files.code, JSON.stringify(next), { mode: 0o600 });
		else
			try {
				unlinkSync(files.code);
			} catch {}
	};

	/** The host's long-term key: made once, the private half never leaves this file. */
	function identity(): KeyPair {
		if (me?.path === files.identity) return me.pair;
		let pair: KeyPair | null = null;
		try {
			const stored = Buffer.from(
				readFileSync(files.identity, "utf8").trim(),
				"hex",
			);
			if (stored.length === 32) pair = keyPairFrom(new Uint8Array(stored));
		} catch {}
		if (!pair) {
			pair = generateKeyPair();
			writeFileSync(
				files.identity,
				Buffer.from(pair.privateKey).toString("hex"),
				{ mode: 0o600 },
			);
		}
		me = { path: files.identity, pair };
		return pair;
	}

	function devices(): Device[] {
		try {
			return JSON.parse(readFileSync(files.devices, "utf8")) as Device[];
		} catch {
			return [];
		}
	}

	const saveDevices = (list: Device[]) =>
		writeFileSync(files.devices, JSON.stringify(list, null, 2), {
			mode: 0o600,
		});

	/** The code for the QR code on screen; a new one once it's used or expired. */
	function pairingCode(now = Date.now()): string {
		const live = readCode();
		if (live && live.expires > now) return live.value;
		const next = {
			value: randomBytes(16).toString("base64url"),
			expires: now + CODE_MS,
		};
		writeCode(next);
		return next.value;
	}

	/**
	 * The handshake's question: a phone on the list is in. A new phone is in once,
	 * with the live pairing code, and is added to the list.
	 */
	function accept(phone: Uint8Array, hello: Hello, now = Date.now()): boolean {
		const key = b64(phone);
		if (devices().some((d) => d.key === key)) return true;
		const code = readCode();
		if (!hello.code || !code || code.expires <= now) return false;
		if (!sameCode(hello.code, code.value)) return false;
		writeCode(null);
		const name = (hello.name ?? "")
			.replace(/[^\p{L}\p{N} '._-]/gu, "")
			.slice(0, 60);
		saveDevices([
			...devices(),
			{ key, name: name || "iPhone", added: new Date(now).toISOString() },
		]);
		return true;
	}

	return {
		identity,
		hostKey: () => b64(identity().publicKey),
		devices,
		removeDevice: (key: string) =>
			saveDevices(devices().filter((d) => d.key !== key)),
		/** A paired phone's push target; null forgets it. Unknown phones are ignored. */
		setPush: (key: string, push: PushTarget | null) =>
			saveDevices(
				devices().map((d) => {
					if (d.key !== key) return d;
					const { push: _, ...rest } = d;
					return push ? { ...rest, push } : rest;
				}),
			),
		pairingCode,
		accept,
		/** Unpair every phone: a new key for the host, an empty list. */
		async resetTrust(): Promise<void> {
			await rm(files.identity, { force: true });
			await rm(files.devices, { force: true });
			me = null;
			writeCode(null);
		},
	};
}

export type Trust = ReturnType<typeof createTrust>;

/** Odin on this computer's files; a test points these at temp files. */
export const trustFiles: TrustFiles = {
	identity: join(ODIN_HOME_DIR, "phone-identity"),
	devices: join(ODIN_HOME_DIR, "phone-devices.json"),
};

const local = createTrust(trustFiles);
export const {
	identity,
	hostKey,
	devices,
	removeDevice,
	setPush,
	pairingCode,
	accept,
	resetTrust,
} = local;
