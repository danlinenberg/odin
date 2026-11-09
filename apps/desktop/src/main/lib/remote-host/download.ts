import { existsSync } from "node:fs";
import { extname, join, posix } from "node:path";

/**
 * A `!download` path as SFTP reads it: absolute stays, `~/x` and `x` are
 * relative to the login's home, where SFTP starts.
 */
export function hostPath(path: string): string {
	const trimmed = path.trim();
	if (trimmed === "~") return ".";
	return trimmed.startsWith("~/") ? trimmed.slice(2) : trimmed;
}

/**
 * Where a host file lands in `dir`: its own name, or "name (2).ext" and up
 * when that is taken, so a download never overwrites a file already there.
 */
export function downloadTarget(
	dir: string,
	remote: string,
	exists: (path: string) => boolean = existsSync,
): string {
	const name = posix.basename(remote.replace(/\/+$/, "")) || "download";
	const ext = extname(name);
	const stem = ext ? name.slice(0, -ext.length) : name;
	let target = join(dir, name);
	for (let n = 2; exists(target); n++)
		target = join(dir, `${stem} (${n})${ext}`);
	return target;
}
