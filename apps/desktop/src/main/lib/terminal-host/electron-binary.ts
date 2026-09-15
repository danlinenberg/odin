/**
 * Resolving the Electron binary to spawn helpers from.
 *
 * `process.execPath` is captured when the process launches and never updated,
 * so it goes stale the moment the bundle it names moves — which the dev flow
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

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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
