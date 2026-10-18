/**
 * Is the terminal-host daemon still running from a bundle an update parked?
 *
 * An update moves the installed Odin.app to ~/.odin/stale/Odin-<epoch>.app
 * and keeps the daemon alive, so open sessions survive (update-swap-script.ts).
 * The daemon and every session it spawns stay on that parked bundle for as
 * long as the daemon lives - across later updates and a reinstall too.
 *
 * macOS charges a session's file access to that bundle: privacy prompts read
 * "Odin-<epoch>" would like to access files in your Desktop folder, and a
 * bundle signed with an older cert than the installed Odin never matches the
 * grant given to the other one, so the prompt comes back.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/** The parked bundle named in `lsof -Fn` output, or null. */
export function parkedBundleIn(lsofOutput: string): string | null {
	return (
		lsofOutput.match(/^n(\/.*\/\.odin\/stale\/Odin-\d+\.app)\//m)?.[1] ?? null
	);
}

/**
 * The parked bundle the daemon in `pidPath` runs from, or null. Its argv still
 * names the old path, so only its open files tell.
 */
export async function daemonParkedBundle(
	pidPath: string,
): Promise<string | null> {
	if (process.platform !== "darwin") return null;
	try {
		const pid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
		if (!(pid > 0)) return null;
		const { stdout } = await promisify(execFile)(
			"lsof",
			["-p", String(pid), "-Fn"],
			{ encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
		);
		return parkedBundleIn(stdout);
	} catch {
		return null;
	}
}
