import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
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
 * `command`, its output also kept in a file. In a terminal it runs under
 * `script`, so it still has one: a login that prompts (gh, aws) won't when
 * its output is a pipe. Without one, tee. In a subshell of its own, so an
 * `exit` in it still leaves its code. The exit file appears only once all
 * output is written - a Ctrl+C that took the command down with its code
 * still writes one, as 130.
 *
 * `unattended` is for a run nobody watches: it can't wait for an answer. Its
 * input is empty, so a prompt fails instead of waiting, and git and gh don't
 * prompt, page or open an editor.
 */
export function wrapLocalRun(
	command: string,
	id: string,
	dir = tmpdir(),
	unattended = false,
): string {
	const { out, code, exit } = runFiles(id, dir);
	const inner = unattended
		? `(\n${UNATTENDED_ENV}\n${command}\n) </dev/null; printf %s $? > ${sh(code)}`
		: `(\n${command}\n); printf %s $? > ${sh(code)}`;
	return [
		"if [ -t 0 ] && [ -t 1 ]; then",
		// -f: Linux script writes the file as output comes, so a quiet run shows.
		`if [ "$(uname)" = Darwin ]; then script -q ${sh(out)} "\${SHELL:-/bin/sh}" -c ${sh(inner)}; else script -qefc ${sh(inner)} ${sh(out)}; fi`,
		`else { ${inner}; } 2>&1 | tee ${sh(out)}; fi`,
		`mv -f ${sh(code)} ${sh(exit)} 2>/dev/null || printf 130 > ${sh(exit)}`,
	].join("\n");
}

const UNATTENDED_ENV =
	"export GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true GIT_PAGER=cat PAGER=cat GH_PAGER=cat GH_PROMPT_DISABLED=1 DEBIAN_FRONTEND=noninteractive";

/** A new run of `command`: its id, and the command the Shell runs. */
export function startLocalRun(
	command: string,
	dir = tmpdir(),
	unattended = false,
) {
	const id = randomUUID();
	return { id, command: wrapLocalRun(command, id, dir, unattended) };
}

/** How much a run has written so far, to tell a quiet one. -1 before it wrote any. */
export async function localRunSize(id: string, dir = tmpdir()) {
	return (await stat(runFiles(id, dir).out).catch(() => null))?.size ?? -1;
}

/**
 * What a terminal shows: colors and `script`'s frame gone, and of a line redrawn with `\r` (a
 * progress bar) only what it ended as. The end of it when it's long.
 */
export function cleanOutput(raw: string, max = LOCAL_OUTPUT_MAX): string {
	const text = stripAnsi(raw)
		.split("\n")
		// util-linux `script` frames the file with these.
		.filter((line) => !/^Script (started|done) on /.test(line))
		.map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
		.join("\n")
		.trim();
	return text.length > max ? `...\n${text.slice(-max)}` : text;
}

/**
 * The run's result once it has ended, or null while it runs. Read once: its
 * files go. `stopped` reads a run that was killed before it could end: what
 * it wrote, as exit code 130.
 */
export async function readLocalRun(
	id: string,
	dir = tmpdir(),
	stopped = false,
): Promise<{ exitCode: number; output: string } | null> {
	const files = runFiles(id, dir);
	const status = await readFile(files.exit, "utf8").catch(() =>
		stopped ? "130" : null,
	);
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
