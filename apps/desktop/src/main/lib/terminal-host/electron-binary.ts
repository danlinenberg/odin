/**
 * Resolving the Electron binary to spawn helpers from.
 *
 * `process.execPath` is captured when the process launches and never updated,
 * so it goes stale the moment the bundle it names moves - which the dev flow
 * does on purpose: patch-dev-protocol.ts renames `dist/Electron.app` to
 * `Odin Dev.app` while an app or a detached daemon is still running out of the
 * old name. Spawning from that path then fails with ENOENT: the daemon never
 * comes up ("Daemon failed to start in time") and forked pty-subprocesses die
 * immediately.
 *
 * The rename leaves `Electron.app` behind as a symlink to the current bundle,
 * and `bun install` restores it as a real directory, so that name resolves in
 * both states.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

/**
 * The Electron binary as it exists on disk right now.
 *
 * Falls back to the input when nothing better is found, so the caller still
 * sees the original ENOENT rather than a second, more confusing failure.
 */
export function resolveElectronBinary(execPath = process.execPath): string {
	if (existsSync(execPath)) return execPath;

	// execPath is <electron>/dist/<Name>.app/Contents/MacOS/Electron
	const distDir = resolve(execPath, "../../../..");
	const viaSymlink = join(
		distDir,
		"Electron.app",
		"Contents",
		"MacOS",
		"Electron",
	);
	return existsSync(viaSymlink) ? viaSymlink : execPath;
}

const STAGED_EXE = "odin-terminal-host.exe";

/**
 * A copy of the Windows install folder to run the terminal-host daemon from.
 *
 * Before it writes, the NSIS installer stops every process whose exe is under
 * the install folder (and, without PowerShell, every `Odin.exe`). A daemon run
 * from there dies with every session on each update. The copy sits outside the
 * folder under another exe name, as the old bundle does on macOS after a swap.
 * Copies of other versions are removed: only spawn calls this, so no live
 * daemon is using them.
 */
export async function stageDaemonRuntime(options: {
	execPath: string;
	appPath: string;
	runtimeRoot: string;
	version: string;
}): Promise<{ exe: string; appPath: string }> {
	const installDir = resolve(options.execPath, "..");
	const dir = join(options.runtimeRoot, options.version);
	const exe = join(dir, STAGED_EXE);

	for (const name of existsSync(options.runtimeRoot)
		? readdirSync(options.runtimeRoot)
		: []) {
		if (name === options.version) continue;
		try {
			rmSync(join(options.runtimeRoot, name), { recursive: true, force: true });
		} catch {
			// A file still in use stays until the next spawn.
		}
	}

	if (!existsSync(exe)) {
		const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
		try {
			await cp(installDir, tmp, { recursive: true });
			await rename(
				join(tmp, basename(options.execPath)),
				join(tmp, STAGED_EXE),
			);
			await rm(dir, { recursive: true, force: true });
			await rename(tmp, dir);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}

	return {
		exe,
		appPath: join(dir, relative(installDir, options.appPath)),
	};
}
