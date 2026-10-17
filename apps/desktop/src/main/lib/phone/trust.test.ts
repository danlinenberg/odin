import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@odin/channel";
import {
	accept,
	CODE_MS,
	devices,
	hostKey,
	pairingCode,
	removeDevice,
	resetTrust,
	trustFiles,
} from "./trust";

const dir = mkdtempSync(join(tmpdir(), "odin-trust-"));
trustFiles.identity = join(dir, "phone-identity");
trustFiles.devices = join(dir, "phone-devices.json");

const key = () => generateKeyPair().publicKey;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

test("Odin's key is made once, kept private, and survives a restart", () => {
	const first = hostKey();
	expect(statSync(trustFiles.identity).mode & 0o777).toBe(0o600);
	expect(hostKey()).toBe(first);
});

test("a new phone pairs once with the live code, and stays paired", () => {
	const phone = key();
	expect(accept(phone, { v: 1 })).toBe(false);
	expect(accept(phone, { v: 1, code: "guess" })).toBe(false);
	const code = pairingCode();
	expect(accept(phone, { v: 1, code, name: "Dan's iPhone" })).toBe(true);
	expect(devices().map((d) => d.name)).toContain("Dan's iPhone");
	expect(accept(phone, { v: 1 })).toBe(true);

	// The code was spent: another phone can't reuse it.
	expect(accept(key(), { v: 1, code })).toBe(false);
	expect(pairingCode()).not.toBe(code);
});

test("an expired code pairs nobody", () => {
	const code = pairingCode();
	expect(accept(key(), { v: 1, code }, Date.now() + CODE_MS + 1)).toBe(false);
});

test("a removed phone is out, and unpairing all changes Odin's key", async () => {
	const phone = key();
	expect(accept(phone, { v: 1, code: pairingCode() })).toBe(true);
	removeDevice(b64(phone));
	expect(accept(phone, { v: 1 })).toBe(false);

	const before = hostKey();
	await resetTrust();
	expect(hostKey()).not.toBe(before);
	expect(devices()).toEqual([]);
});
