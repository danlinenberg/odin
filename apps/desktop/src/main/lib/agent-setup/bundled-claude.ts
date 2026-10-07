import fs from "node:fs";
import path from "node:path";

/**
 * The Claude Code binary Odin ships (scripts/fetch-claude.ts), or null when
 * this build has none - dev runs and non-mac builds. Only used when you have
 * no `claude` of your own: it is the last place anything looks.
 */
export function bundledClaudePath(): string | null {
	if (!process.resourcesPath) return null;
	const bin = path.join(process.resourcesPath, "resources/bin/claude");
	return fs.existsSync(bin) ? bin : null;
}
