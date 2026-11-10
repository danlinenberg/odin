import { posix, win32 } from "node:path";
import stripAnsi from "strip-ansi";

/**
 * What `claude auth login` says in its terminal, read by claude-token.ts.
 */

/** Where `claude` may be on PATH: on Windows it is claude.exe or claude.cmd. */
export function claudeOnPath(
	pathEnv: string,
	platform: NodeJS.Platform,
): string[] {
	const windows = platform === "win32";
	const names = windows ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
	const { join: joinPath, delimiter } = windows ? win32 : posix;
	return pathEnv
		.split(delimiter)
		.filter(Boolean)
		.flatMap((dir) => names.map((name) => joinPath(dir, name)));
}

/** The sign-in page from `claude auth login`'s "If the browser didn't open, visit: <url>" line. */
export function signInLink(output: string): string | null {
	// A cursor move between the link and what follows separates them as a space would.
	const text = stripAnsi(output.replaceAll("\x1b", " \x1b"));
	return text.match(/visit:\s*(https:\/\/\S+)\s/)?.[1] ?? null;
}

/** Claude waits at "Paste code here if prompted >" for the code the sign-in page shows. */
export function asksForCode(output: string): boolean {
	return /Paste code here/i.test(stripAnsi(output));
}
