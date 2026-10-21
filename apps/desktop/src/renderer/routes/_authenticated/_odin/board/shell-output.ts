import stripAnsi from "strip-ansi";

/** A `!` command and what it printed, or a built-in command's (/cost, /context) output alone. */
export type Shell = { command?: string; stdout: string; stderr: string };

function tag(text: string, name: string): string {
	const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return stripAnsi(match?.[1] ?? "").replace(/^\n+|\s+$/g, "");
}

/** How Claude Code logs a shell run as a user message; null for anything you typed. */
export function parseShell(text: string): Shell | null {
	const command = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/)?.[1];
	if (command !== undefined)
		return {
			command,
			stdout: tag(text, "bash-stdout"),
			stderr: tag(text, "bash-stderr"),
		};
	if (/^\s*<bash-std(out|err)>/.test(text))
		return {
			stdout: tag(text, "bash-stdout"),
			stderr: tag(text, "bash-stderr"),
		};
	if (/^\s*<local-command-std(out|err)>/.test(text))
		return {
			stdout: tag(text, "local-command-stdout"),
			stderr: tag(text, "local-command-stderr"),
		};
	return null;
}
