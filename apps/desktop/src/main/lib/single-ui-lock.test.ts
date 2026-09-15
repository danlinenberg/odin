import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

const isProcessAliveMock = mock((_pid: number) => true);

mock.module("./host-service-manifest", () => ({
	isProcessAlive: isProcessAliveMock,
}));

const { acquireSingleUiLock } = await import("./single-ui-lock");

let home = "";
const lockFile = () => path.join(home, "ui.lock");

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "odin-ui-lock-"));
	isProcessAliveMock.mockReset();
	isProcessAliveMock.mockImplementation(() => true);
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

/** Simulate another UI holding the dir. */
function writeHolder(pid: number, app = "Odin") {
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(
		lockFile(),
		JSON.stringify({ pid, app, acquiredAt: Date.now() }),
	);
}

describe("acquireSingleUiLock", () => {
	test("first UI claims the home dir", () => {
		const result = acquireSingleUiLock("Odin", home);
		expect(result.ok).toBe(true);
		expect(JSON.parse(fs.readFileSync(lockFile(), "utf-8"))).toMatchObject({
			pid: process.pid,
			app: "Odin",
		});
	});

	test("second UI is refused while the holder is alive", () => {
		writeHolder(4242, "Odin Dev");

		const result = acquireSingleUiLock("Odin", home);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		// The message names who to quit, so the dialog is actionable.
		expect(result.holder).toMatchObject({ pid: 4242, app: "Odin Dev" });
	});

	test("a live holder is never stolen, however old the lock", () => {
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(
			lockFile(),
			JSON.stringify({ pid: 4242, app: "Odin", acquiredAt: 0 }),
		);

		expect(acquireSingleUiLock("Odin", home).ok).toBe(false);
	});

	test("a dead holder's lock is stolen — a crash must not lock the user out", () => {
		writeHolder(4242);
		isProcessAliveMock.mockImplementation(() => false);

		const result = acquireSingleUiLock("Odin", home);

		expect(result.ok).toBe(true);
		expect(JSON.parse(fs.readFileSync(lockFile(), "utf-8")).pid).toBe(
			process.pid,
		);
	});

	test("a garbage lock file is not a permanent lockout", () => {
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(lockFile(), "{ partial wri");

		expect(acquireSingleUiLock("Odin", home).ok).toBe(true);
	});

	test("release frees the dir for the next UI", () => {
		const first = acquireSingleUiLock("Odin", home);
		if (!first.ok) throw new Error("expected to acquire");

		first.release();

		expect(fs.existsSync(lockFile())).toBe(false);
		expect(acquireSingleUiLock("Odin Dev", home).ok).toBe(true);
	});
});
