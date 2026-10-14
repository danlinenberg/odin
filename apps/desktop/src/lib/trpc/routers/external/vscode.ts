import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

/**
 * VS Code's own URL handler. It is registered by the app itself, so it opens
 * the folder with no `code` CLI on PATH and whatever the .app is named.
 */
export function vscodeFolderUrl(
	dir: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const forward = platform === "win32" ? dir.replaceAll("\\", "/") : dir;
	const rooted = forward.startsWith("/") ? forward : `/${forward}`;
	return `vscode://file${encodeURI(rooted)}`;
}

/** The Claude Code extension's URL: opens this conversation in its panel. */
export function claudeCodeSessionUrl(sessionId: string): string {
	return `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;
}

/**
 * Whether VS Code has the Claude Code extension - `claude` installs it the
 * first time it runs in VS Code's terminal.
 */
export function hasClaudeCodeExtension(
	extensionsDir = nodePath.join(os.homedir(), ".vscode", "extensions"),
): boolean {
	try {
		return fs
			.readdirSync(extensionsDir)
			.some((name) => name.startsWith("anthropic.claude-code-"));
	} catch {
		return false;
	}
}
