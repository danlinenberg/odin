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

import { existsSync } from "node:fs";
import {
	copyFile,
	cp,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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
 * A copy of what the Windows terminal-host daemon runs, outside the install
 * folder.
 *
 * Before it writes, the NSIS installer stops every process whose exe is under
 * the install folder (and, without PowerShell, every `Odin.exe`). A daemon run
 * from there dies with every session on each update. The copy sits outside the
 * folder under another exe name, as the old bundle does on macOS after a swap.
 *
 * Only what the daemon loads: the exe with the files beside it, `dist/main`
 * read out of the asar, and node-pty, its one native module (~330 MB of the
 * install's 1.1 GB). Copies of other versions are removed: only spawn calls
 * this, so no live daemon is using them.
 */
export async function stageDaemonRuntime(options: {
	execPath: string;
	appPath: string;
	runtimeRoot: string;
	version: string;
}): Promise<{ exe: string; appPath: string }> {
	const installDir = dirname(options.execPath);
	const dir = join(options.runtimeRoot, options.version);
	const exe = join(dir, STAGED_EXE);
	const appDir = join(dir, "resources", "app");

	for (const name of existsSync(options.runtimeRoot)
		? await readdir(options.runtimeRoot)
		: []) {
		if (name === options.version) continue;
		try {
			await rm(join(options.runtimeRoot, name), {
				recursive: true,
				force: true,
			});
		} catch {
			// A file still in use stays until the next spawn.
		}
	}

	if (!existsSync(exe)) {
		const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
		const tmpApp = join(tmp, "resources", "app");
		try {
			await mkdir(tmp, { recursive: true });
			for (const entry of await readdir(installDir, { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				await copyFile(
					join(installDir, entry.name),
					join(
						tmp,
						entry.name === basename(options.execPath) ? STAGED_EXE : entry.name,
					),
				);
			}
			// Through Electron's asar-aware fs, file by file: fs.cp has no asar
			// support.
			await copyTree(
				join(options.appPath, "dist", "main"),
				join(tmpApp, "dist", "main"),
			);
			await cp(
				join(`${options.appPath}.unpacked`, "node_modules", "node-pty"),
				join(tmpApp, "node_modules", "node-pty"),
				{ recursive: true },
			);
			await rm(dir, { recursive: true, force: true });
			await rename(tmp, dir);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}

	return { exe, appPath: appDir };
}

async function copyTree(from: string, to: string): Promise<void> {
	await mkdir(to, { recursive: true });
	for (const entry of await readdir(from, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			await copyTree(join(from, entry.name), join(to, entry.name));
		} else {
			await writeFile(
				join(to, entry.name),
				await readFile(join(from, entry.name)),
			);
		}
	}
}
