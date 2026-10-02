import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ODIN_HOME_DIR } from "./app-environment";

const run = promisify(execFile);

/**
 * Copy the board's data off this disk once a day, into iCloud Drive — the one
 * off-machine place every Mac already syncs. Nothing else backs ~/.odin up, so
 * a dead disk used to take every task, brief and scrollback with it.
 *
 * SQLite files go through `sqlite3 .backup`, which takes a consistent copy of
 * a database another process is writing to; a plain cp of a WAL database can
 * restore torn. ~/.config/odin.json stays out: it holds OAuth client secrets.
 * Restore by quitting Odin and copying a dated folder's files back into ~/.odin.
 */
export const BACKUP_DIR = path.join(
	homedir(),
	"Library/Mobile Documents/com~apple~CloudDocs/Odin Backups",
);
const KEEP_DAYS = 14;
const DATABASES = ["local.db", "tanstack-db.sqlite"];
const FILES = ["app-state.json", "session-briefs.json", "attention.jsonl"];
const EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_MS = 10 * 60 * 1000;

async function hostDatabases(src: string): Promise<string[]> {
	const hostDir = path.join(src, "host");
	if (!existsSync(hostDir)) return [];
	const orgs = await readdir(hostDir);
	return orgs
		.map((org) => path.join("host", org, "host.db"))
		.filter((db) => existsSync(path.join(src, db)));
}

/** Writes `<dest>/<YYYY-MM-DD>/`, at most once a day; returns it, or null when skipped. */
export async function backupOdinData(
	src: string,
	dest: string,
	today = new Date().toISOString().slice(0, 10),
): Promise<string | null> {
	// No iCloud Drive (signed out, or turned off): a backup on this same disk
	// protects nothing, so don't make one.
	if (!existsSync(path.dirname(dest))) return null;
	const dir = path.join(dest, today);
	if (existsSync(dir)) return null;

	// Build under a temp name, so a half-written day never counts as done.
	const tmp = `${dir}.partial`;
	await rm(tmp, { recursive: true, force: true });
	await mkdir(tmp, { recursive: true });
	for (const db of [...DATABASES, ...(await hostDatabases(src))]) {
		if (!existsSync(path.join(src, db))) continue;
		await mkdir(path.dirname(path.join(tmp, db)), { recursive: true });
		await run("sqlite3", [
			path.join(src, db),
			`.backup '${path.join(tmp, db)}'`,
		]);
	}
	for (const file of FILES) {
		if (existsSync(path.join(src, file)))
			await copyFile(path.join(src, file), path.join(tmp, file));
	}
	if (existsSync(path.join(src, "terminal-history"))) {
		await run("tar", [
			"-czf",
			path.join(tmp, "terminal-history.tgz"),
			"-C",
			src,
			"terminal-history",
		]);
	}
	await rename(tmp, dir);

	const days = (await readdir(dest))
		.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
		.sort();
	for (const old of days.slice(0, -KEEP_DAYS))
		await rm(path.join(dest, old), { recursive: true, force: true });
	return dir;
}

function backup(): void {
	backupOdinData(ODIN_HOME_DIR, BACKUP_DIR)
		.then((dir) => dir && console.warn(`[main] backed up Odin data to ${dir}`))
		.catch((error: unknown) =>
			console.warn("[main] Odin data backup failed:", error),
		);
}

export function startDataBackup(): void {
	setTimeout(() => {
		backup();
		setInterval(backup, EVERY_MS).unref();
	}, FIRST_RUN_MS).unref();
}
