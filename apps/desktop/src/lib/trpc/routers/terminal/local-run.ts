import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";

/**
 * Odin fork: a `!local` command run in the session's Shell, with its output
 * kept so it can go back to Claude. The Shell still shows it as it runs.
 */

/** The most of a run's output that goes back to Claude: its end. */
export const LOCAL_OUTPUT_MAX = 8_000;

const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const runFiles = (id: string, dir: string) => {
	const base = join(dir, `odin-local-${id}`);
	return { out: `${base}.out`, code: `${base}.code`, exit: `${base}.exit` };
};

/**
 * `command`, its output also kept in a file. In a subshell of its own, so an
 * `exit` in it still leaves its code. The exit file appears only once tee
 * has written all of it - a Ctrl+C that took the command down with its
 * code still writes one, as 130.
 */
export function wrapLocalRun(
	command: string,
	id: string,
	dir = tmpdir(),
): string {
	const { out, code, exit } = runFiles(id, dir);
	return `{ (\n${command}\n); printf %s $? > ${sh(code)}; } 2>&1 | tee ${sh(out)}\nmv -f ${sh(code)} ${sh(exit)} 2>/dev/null || printf 130 > ${sh(exit)}`;
}

/** A new run of `command`: its id, and the command the Shell runs. */
export function startLocalRun(command: string, dir = tmpdir()) {
	const id = randomUUID();
	return { id, command: wrapLocalRun(command, id, dir) };
}

/**
 * What a terminal shows: colors gone, and of a line redrawn with `\r` (a
 * progress bar) only what it ended as. The end of it when it's long.
 */
export function cleanOutput(raw: string, max = LOCAL_OUTPUT_MAX): string {
	const text = stripAnsi(raw)
		.split("\n")
		.map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
		.join("\n")
		.trim();
	return text.length > max ? `...\n${text.slice(-max)}` : text;
}

/** The run's result once it has ended, or null while it runs. Read once: its files go. */
export async function readLocalRun(
	id: string,
	dir = tmpdir(),
): Promise<{ exitCode: number; output: string } | null> {
	const files = runFiles(id, dir);
	const status = await readFile(files.exit, "utf8").catch(() => null);
	if (status === null) return null;
	const raw = await readFile(files.out, "utf8").catch(() => "");
	await Promise.all(
		Object.values(files).map((file) => rm(file, { force: true })),
	);
	const exitCode = Number.parseInt(status.trim(), 10);
	return {
		exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
		output: cleanOutput(raw),
	};
}
