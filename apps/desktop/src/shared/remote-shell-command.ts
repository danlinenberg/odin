/**
 * The command a remote session's pane runs, and its parts back from it.
 *
 * On Windows the terminal host starts those parts itself, over plain pipes,
 * instead of running the command in Git Bash: Odin.exe is a GUI program, so
 * under Bash it got pipes behind a console - its UTF-8 came out in the
 * console's code page and it never learned the pane's size.
 */

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
const QUOTED = `'(?:[^']|'\\\\'')*'`;
const COMMAND = new RegExp(
	`^ELECTRON_RUN_AS_NODE=1 (${QUOTED}) (${QUOTED}) (${QUOTED}) (\\S+)$`,
);
const unquote = (text: string) => text.slice(1, -1).replaceAll(`'\\''`, "'");

export function remoteShellCommand(parts: {
	exe: string;
	script: string;
	spec: string;
	ticket: string;
}): string {
	return `ELECTRON_RUN_AS_NODE=1 ${quote(parts.exe)} ${quote(parts.script)} ${quote(parts.spec)} ${parts.ticket}`;
}

/** The program and its arguments, or null for any other command. */
export function remoteShellArgv(
	command: string,
): { exe: string; args: string[] } | null {
	const match = command.match(COMMAND);
	if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
	const script = unquote(match[2]);
	if (!/remote-shell\.js$/.test(script)) return null;
	return {
		exe: unquote(match[1]),
		args: [script, unquote(match[3]), match[4]],
	};
}
