import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "../app-environment";

/**
 * What each session got from the phone, so the desktop chat can mark those
 * messages "from iPhone": Odin types a phone reply into the session like any
 * other, and the transcript can't tell them apart.
 */

/** A test points it at a temp file. */
export const phoneSentFile = { path: join(ODIN_HOME_DIR, "phone-sent.json") };

/** The latest texts per session; older ones have scrolled out of the chat. */
const KEEP = 50;

function readAll(): Record<string, string[]> {
	try {
		return JSON.parse(readFileSync(phoneSentFile.path, "utf8"));
	} catch {
		return {};
	}
}

export function rememberFromPhone(paneId: string, text: string): void {
	if (!text.trim()) return;
	const all = readAll();
	all[paneId] = [...(all[paneId] ?? []), text.trim()].slice(-KEEP);
	writeFileSync(phoneSentFile.path, JSON.stringify(all), { mode: 0o600 });
}

export const sentFromPhone = (paneId: string): string[] =>
	readAll()[paneId] ?? [];
