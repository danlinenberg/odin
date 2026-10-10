import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveElectronBinary, stageDaemonRuntime } from "./electron-binary";

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

describe("stageDaemonRuntime", () => {
	it("copies the daemon's files out of the install folder and drops other versions", async () => {
		const root = mkdtempSync(join(tmpdir(), "odin-stage-"));
		const install = join(root, "Programs", "Odin");
		const asar = join(install, "resources", "app.asar");
		const pty = join(`${asar}.unpacked`, "node_modules", "node-pty");
		mkdirSync(join(asar, "dist", "main", "chunks"), { recursive: true });
		mkdirSync(join(install, "locales"), { recursive: true });
		mkdirSync(pty, { recursive: true });
		writeFileSync(join(install, "Odin.exe"), "exe");
		writeFileSync(join(install, "ffmpeg.dll"), "dll");
		writeFileSync(join(asar, "dist", "main", "chunks", "a.js"), "js");
		writeFileSync(join(pty, "conpty.node"), "node");
		const runtimeRoot = join(root, "runtime");
		mkdirSync(join(runtimeRoot, "1.0.14"), { recursive: true });

		const staged = await stageDaemonRuntime({
			execPath: join(install, "Odin.exe"),
			appPath: asar,
			runtimeRoot,
			version: "1.0.15",
		});

		const dir = join(runtimeRoot, "1.0.15");
		expect(staged).toEqual({
			exe: join(dir, "odin-terminal-host.exe"),
			appPath: join(dir, "resources", "app"),
		});
		expect(readdirSync(dir).sort()).toEqual([
			"ffmpeg.dll",
			"odin-terminal-host.exe",
			"resources",
		]);
		expect(
			existsSync(join(staged.appPath, "dist", "main", "chunks", "a.js")),
		).toBe(true);
		expect(
			existsSync(
				join(staged.appPath, "node_modules", "node-pty", "conpty.node"),
			),
		).toBe(true);
		expect(readdirSync(runtimeRoot)).toEqual(["1.0.15"]);
	});
});
