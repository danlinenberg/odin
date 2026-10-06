import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Where the terminal-host daemon listens. A Unix socket file under the Odin
 * home everywhere but Windows, which has no socket files - `listen()` on a
 * path there fails with EACCES - and gets a named pipe instead. Pipes live in
 * one machine-wide namespace, so the name hashes the home dir to keep each
 * dev worktree's `~/.odin-<workspace>` apart.
 */
export function terminalHostSocketPath(
	odinHomeDir: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return join(odinHomeDir, "terminal-host.sock");
	const homeHash = createHash("sha256")
		.update(odinHomeDir)
		.digest("hex")
		.slice(0, 12);
	return `\\\\.\\pipe\\odin-terminal-host-${homeHash}`;
}
