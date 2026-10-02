import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backupOdinData } from "./backup-data";

test("copies a live database consistently, once a day, keeping 14 days", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "odin-backup-"));
	const src = path.join(root, "odin");
	const dest = path.join(root, "cloud", "Odin Backups");
	mkdirSync(path.join(src, "host", "org"), { recursive: true });
	mkdirSync(path.join(src, "terminal-history", "s1"), { recursive: true });
	mkdirSync(dest, { recursive: true });
	for (const db of ["local.db", "host/org/host.db"])
		execFileSync("sqlite3", [
			path.join(src, db),
			"PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (42);",
		]);
	writeFileSync(path.join(src, "app-state.json"), "{}");
	writeFileSync(path.join(src, "terminal-history", "s1", "screen"), "hi");

	const dir = await backupOdinData(src, dest, "2026-10-02");
	expect(dir).toBe(path.join(dest, "2026-10-02"));
	for (const db of ["local.db", "host/org/host.db"])
		expect(
			execFileSync("sqlite3", [
				path.join(dest, "2026-10-02", db),
				"SELECT x FROM t",
			])
				.toString()
				.trim(),
		).toBe("42");
	expect(existsSync(path.join(dest, "2026-10-02", "app-state.json"))).toBe(
		true,
	);
	expect(
		existsSync(path.join(dest, "2026-10-02", "terminal-history.tgz")),
	).toBe(true);

	expect(await backupOdinData(src, dest, "2026-10-02")).toBeNull();
	for (let d = 3; d <= 20; d++)
		await backupOdinData(src, dest, `2026-10-${String(d).padStart(2, "0")}`);
	const days = readdirSync(dest).sort();
	expect(days.length).toBe(14);
	expect(days[0]).toBe("2026-10-07");

	expect(
		await backupOdinData(src, path.join(root, "no-icloud", "Odin Backups")),
	).toBeNull();
});
