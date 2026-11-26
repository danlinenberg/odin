import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type ClaudeSetupPart, partPaths } from "./claude-sync";

/**
 * How long a session start waits for the Claude setup to reach its host.
 * A bigger copy goes on behind the session; the session never waits longer.
 */
export const AUTO_SYNC_WAIT_MS = 8_000;

/** What tar leaves out (claude-sync's syncClaudeSetup), left out here too. */
const SKIPPED = new Set([".DS_Store", "node_modules"]);

/**
 * A fingerprint of the chosen parts of ~/.claude: every file's path, size and
 * last change, the way tar copies them (a symlink by what it points at).
 * Reads file details only, never their contents, so it stays cheap. It
 * changes when a skill, command or setting is added, edited or removed.
 */
export async function setupFingerprint(
	parts: readonly ClaudeSetupPart[],
	root: string,
): Promise<string> {
	const hash = createHash("sha256");
	hash.update(`${[...parts].sort().join(",")}\n`);
	const seen = new Set<string>();
	const walk = async (relative: string, depth: number): Promise<void> => {
		const full = join(root, relative);
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(full);
		} catch {
			return;
		}
		if (info.isDirectory()) {
			// A link loop (a skill linking to its own parent) ends here.
			const id = `${info.dev}:${info.ino}`;
			if (seen.has(id) || depth > 40) return;
			seen.add(id);
			let names: string[];
			try {
				names = (await readdir(full)).sort();
			} catch {
				return;
			}
			hash.update(`d ${relative}\n`);
			for (const name of names)
				if (!SKIPPED.has(name)) await walk(join(relative, name), depth + 1);
			seen.delete(id);
			return;
		}
		hash.update(`f ${relative} ${info.size} ${Math.floor(info.mtimeMs)}\n`);
	};
	const paths = [...new Set(parts.flatMap((part) => partPaths(part, root)))];
	for (const path of paths.sort()) await walk(path, 0);
	return hash.digest("hex");
}

/** Where an auto sync reads and records what each host last got. */
export interface AutoSyncDeps<H> {
	/** The parts chosen in Settings; empty when the user chose none. */
	parts: () => readonly ClaudeSetupPart[];
	fingerprint: (parts: readonly ClaudeSetupPart[]) => Promise<string>;
	/** One host per Linux user on an instance: `instanceId:user`. */
	keyOf: (host: H) => string;
	/** The fingerprint the host got last, if any. */
	sent: (key: string) => string | undefined;
	record: (key: string, fingerprint: string) => void;
	copy: (host: H, parts: readonly ClaudeSetupPart[]) => Promise<void>;
	log?: (message: string, error: unknown) => void;
}

/**
 * Copies the chosen parts of ~/.claude to a host when they changed since its
 * last copy, before a session starts there. A copy already going to that host
 * is shared, never started twice. Never throws: a failed copy is logged and
 * left unrecorded, so the next session start tries again.
 */
export function makeAutoSync<H>(deps: AutoSyncDeps<H>) {
	const running = new Map<string, Promise<boolean>>();
	return (host: H): Promise<boolean> => {
		const key = deps.keyOf(host);
		const already = running.get(key);
		if (already) return already;
		const job = (async () => {
			const parts = deps.parts();
			if (!parts.length) return false;
			try {
				// Taken before the copy, so a change made while it runs goes next time.
				const print = await deps.fingerprint(parts);
				if (deps.sent(key) === print) return false;
				await deps.copy(host, parts);
				deps.record(key, print);
				return true;
			} catch (error) {
				(deps.log ?? console.warn)(
					"[remote-host] Claude setup auto sync:",
					error,
				);
				return false;
			}
		})().finally(() => running.delete(key));
		running.set(key, job);
		return job;
	};
}

/** `job`, or nothing once `ms` pass: the job goes on either way. */
export function waitAtMost<T>(job: Promise<T>, ms: number): Promise<T | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		timer.unref?.();
		job.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}
