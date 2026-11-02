import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@odin/channel";
import {
	accept,
	CODE_MS,
	createTrust,
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

test("a phone the laptop vouches for is in on a host, with no code, until it leaves the list", async () => {
	const hostDir = mkdtempSync(join(tmpdir(), "odin-trust-host-"));
	const files = {
		identity: join(hostDir, "identity"),
		devices: join(hostDir, "devices.json"),
		code: join(hostDir, "code.json"),
		shared: join(hostDir, "laptop-devices.json"),
	};
	const host = createTrust(files);
	const phone = key();
	expect(host.accept(phone, { v: 1 })).toBe(false);

	const entry = { key: b64(phone), name: "iPhone", added: "2026-11-02" };
	writeFileSync(files.shared, JSON.stringify([entry]));
	expect(host.accept(phone, { v: 1 })).toBe(true);
	// Let in, not copied: the laptop's list stays the one that decides.
	expect(host.devices()).toEqual([]);
	expect(host.accept(key(), { v: 1 })).toBe(false);

	writeFileSync(files.shared, "[]");
	expect(host.accept(phone, { v: 1 })).toBe(false);

	writeFileSync(files.shared, "not json");
	expect(host.accept(phone, { v: 1 })).toBe(false);

	writeFileSync(files.shared, JSON.stringify([entry]));
	await host.resetTrust();
	expect(existsSync(files.shared)).toBe(false);
});
