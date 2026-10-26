import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Claude Code binary Odin ships (scripts/fetch-claude.ts), or null when
 * this build has none - dev runs. Only used when you have no `claude` of your
 * own: it is the last place anything looks.
 *
 * On Windows, Claude's own installer puts claude.exe in ~\.local\bin and
 * leaves adding that to PATH to you, so a copy there wins over Odin's.
 */
export function bundledClaudePath(): string | null {
	const win = process.platform === "win32";
	const own = win && path.join(os.homedir(), ".local", "bin", "claude.exe");
	if (own && fs.existsSync(own)) return own;
	if (!process.resourcesPath) return null;
	const bin = path.join(
		process.resourcesPath,
		"resources",
		"bin",
		win ? "claude.exe" : "claude",
	);
	return fs.existsSync(bin) ? bin : null;
}
