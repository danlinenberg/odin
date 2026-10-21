import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hostHome, type RemoteFile } from "./session";

/**
 * Where each copy on the host came from on this computer, by the copy's
 * absolute path there. A remote session's prompt names the copies, which
 * this computer can't read, and the chat view shows a launch prompt's
 * screenshots from disk: this maps a copy back to its file here. An object
 * so a test can point it elsewhere.
 */
export const hostFilesStore = {
	path: join(homedir(), ".odin", "host-files.json"),
};

/** The newest copies kept; a screenshot per task adds one, so this lasts years. */
const KEEP = 1000;

// Writes queue behind one another: two launches at once would otherwise read
// the same file, and the second write drop the first one's entries.
let writing: Promise<void> = Promise.resolve();

/** Remembers which laptop file each copy on the host came from. */
export function rememberHostFiles(
	user: string,
	files: RemoteFile[],
): Promise<void> {
	if (files.length === 0) return writing;
	writing = writing
		.then(async () => {
			const known = await readStore();
			for (const file of files)
				known[`${hostHome(user)}/${file.remote}`] = file.local;
			await mkdir(dirname(hostFilesStore.path), { recursive: true });
			await writeFile(
				hostFilesStore.path,
				JSON.stringify(Object.fromEntries(Object.entries(known).slice(-KEEP))),
			);
		})
		.catch((error) => {
			console.warn("[remote-host] host files:", error);
		});
	return writing;
}

/** Each copy on the host and the laptop file it came from. */
export async function hostFileSources(): Promise<Record<string, string>> {
	await writing;
	return readStore();
}

async function readStore(): Promise<Record<string, string>> {
	try {
		const parsed: unknown = JSON.parse(
			await readFile(hostFilesStore.path, "utf-8"),
		);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, string>)
			: {};
	} catch {
		return {};
	}
}
