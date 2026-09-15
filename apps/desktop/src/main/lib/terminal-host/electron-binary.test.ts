import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveElectronBinary } from "./electron-binary";

/** A dist dir holding one bundle, plus the Electron.app link pointing at it. */
function makeDist(bundleName: string, link: boolean): string {
	const dist = mkdtempSync(join(tmpdir(), "electron-dist-"));
	const macOs = join(dist, bundleName, "Contents", "MacOS");
	mkdirSync(macOs, { recursive: true });
	writeFileSync(join(macOs, "Electron"), "");
	if (link) symlinkSync(bundleName, join(dist, "Electron.app"));
	return dist;
}

const binaryIn = (dist: string, bundleName: string) =>
	join(dist, bundleName, "Contents", "MacOS", "Electron");

describe("resolveElectronBinary", () => {
	it("keeps an execPath that still exists", () => {
		const dist = makeDist("Odin Dev.app", true);
		const execPath = binaryIn(dist, "Odin Dev.app");

		expect(resolveElectronBinary(execPath)).toBe(execPath);
	});

	it("follows Electron.app when the bundle was renamed underneath it", () => {
		const dist = makeDist("Odin Dev.app", true);

		expect(resolveElectronBinary(binaryIn(dist, "Odin (old).app"))).toBe(
			binaryIn(dist, "Electron.app"),
		);
	});

	it("resolves a real Electron.app directory, as bun install restores it", () => {
		const dist = makeDist("Electron.app", false);

		expect(resolveElectronBinary(binaryIn(dist, "Odin (old).app"))).toBe(
			binaryIn(dist, "Electron.app"),
		);
	});

	it("returns the original path when nothing on disk matches", () => {
		const missing = "/nonexistent/dist/Whatever.app/Contents/MacOS/Electron";

		expect(resolveElectronBinary(missing)).toBe(missing);
	});
});
