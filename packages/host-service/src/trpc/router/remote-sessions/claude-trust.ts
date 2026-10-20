import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Mark a folder trusted in this host's ~/.claude.json, so Claude starts
 * straight into the task instead of asking "Do you trust the files in this
 * folder?". A remote session runs while nobody watches - a Night Agent run at
 * 2am would sit on that prompt until morning. Only folders the user opened as
 * a project in Odin get here.
 *
 * Touches nothing but `projects[folder].hasTrustDialogAccepted`, writes via
 * rename so Claude never reads a half-written file, and leaves a file it
 * cannot parse alone.
 */
export async function markClaudeFolderTrusted(
	folder: string,
	file = join(homedir(), ".claude.json"),
): Promise<void> {
	let config: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
		config = parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
	}
	const projects =
		config.projects && typeof config.projects === "object"
			? (config.projects as Record<string, Record<string, unknown>>)
			: {};
	if (projects[folder]?.hasTrustDialogAccepted === true) return;
	projects[folder] = { ...projects[folder], hasTrustDialogAccepted: true };
	config.projects = projects;
	const temp = `${file}.odin-${process.pid}`;
	await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
	await rename(temp, file);
}
