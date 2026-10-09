import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The Claude Code binary Odin ships (scripts/fetch-claude.ts), or null when
 * this build has none - dev runs and non-mac builds. Only used when you have
 * no `claude` of your own: it is the last place anything looks.
 *
 * Windows ships none, but Claude's own installer puts claude.exe in
 * ~\.local\bin and leaves adding that to PATH to you - so look there.
 */
export function bundledClaudePath(): string | null {
	if (process.platform === "win32") {
		const bin = path.join(os.homedir(), ".local", "bin", "claude.exe");
		return fs.existsSync(bin) ? bin : null;
	}
	if (!process.resourcesPath) return null;
	const bin = path.join(process.resourcesPath, "resources/bin/claude");
	return fs.existsSync(bin) ? bin : null;
}
