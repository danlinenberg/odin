import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	generateKeyPair,
	type Hello,
	type KeyPair,
	keyPairFrom,
} from "@odin/channel";
import { ODIN_HOME_DIR } from "../app-environment";

/**
 * Who may talk to Odin from a phone (docs/phone-encryption.md): Odin's own
 * key, the phones it trusts, and the one-time code the QR code carries.
 */

/** A test points these at temp files. */
export const trustFiles = {
	identity: join(ODIN_HOME_DIR, "phone-identity"),
	devices: join(ODIN_HOME_DIR, "phone-devices.json"),
};

export type Device = { key: string; name: string; added: string };

/** A pairing code lasts 10 minutes and pairs one phone. */
export const CODE_MS = 10 * 60 * 1000;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

let me: KeyPair | null = null;
let code: { value: string; expires: number } | null = null;

/** Odin's long-term key: made once, the private half never leaves this file. */
export function identity(): KeyPair {
	if (me) return me;
	try {
		const stored = Buffer.from(
			readFileSync(trustFiles.identity, "utf8").trim(),
			"hex",
		);
		if (stored.length === 32) me = keyPairFrom(new Uint8Array(stored));
	} catch {}
	if (!me) {
		me = generateKeyPair();
		writeFileSync(
			trustFiles.identity,
			Buffer.from(me.privateKey).toString("hex"),
			{
				mode: 0o600,
			},
		);
	}
	return me;
}

export const hostKey = () => b64(identity().publicKey);

export function devices(): Device[] {
	try {
		return JSON.parse(readFileSync(trustFiles.devices, "utf8")) as Device[];
	} catch {
		return [];
	}
}

const saveDevices = (list: Device[]) =>
	writeFileSync(trustFiles.devices, JSON.stringify(list, null, 2), {
		mode: 0o600,
	});

export const removeDevice = (key: string) =>
	saveDevices(devices().filter((d) => d.key !== key));

/** The code for the QR code on screen; a new one once it's used or expired. */
export function pairingCode(now = Date.now()): string {
	if (!code || code.expires <= now)
		code = {
			value: randomBytes(16).toString("base64url"),
			expires: now + CODE_MS,
		};
	return code.value;
}

const sameCode = (given: string, expected: string) => {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The handshake's question: a phone on the list is in. A new phone is in once,
 * with the live pairing code, and is added to the list.
 */
export function accept(
	phone: Uint8Array,
	hello: Hello,
	now = Date.now(),
): boolean {
	const key = b64(phone);
	if (devices().some((d) => d.key === key)) return true;
	if (!hello.code || !code || code.expires <= now) return false;
	if (!sameCode(hello.code, code.value)) return false;
	code = null;
	const name = (hello.name ?? "")
		.replace(/[^\p{L}\p{N} '._-]/gu, "")
		.slice(0, 60);
	saveDevices([
		...devices(),
		{ key, name: name || "iPhone", added: new Date(now).toISOString() },
	]);
	return true;
}

/** Unpair every phone: a new key for Odin, an empty list. */
export async function resetTrust(): Promise<void> {
	await rm(trustFiles.identity, { force: true });
	await rm(trustFiles.devices, { force: true });
	me = null;
	code = null;
}
