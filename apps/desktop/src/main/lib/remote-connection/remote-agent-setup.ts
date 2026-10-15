import {
	mergeClaudeManagedSettings,
	parseClaudeSettingsJson,
} from "../agent-setup/agent-wrappers-claude-codex-opencode";
import { buildWrapperScript } from "../agent-setup/agent-wrappers-common";
import {
	getNotifyScriptContent,
	getShellRuleScriptContent,
	getSubagentCapScriptContent,
	NOTIFY_SCRIPT_NAME,
	SHELL_RULE_SCRIPT_NAME,
	SUBAGENT_CAP_SCRIPT_NAME,
} from "../agent-setup/notify-hook";
import { shellQuote } from "./ssh";

/**
 * Odin's agent setup for a remote server - the same hook scripts, `claude`
 * wrapper and ~/.claude/settings.json hooks the laptop installs for its own
 * sessions, rendered for the server's odin folder. Remote sessions run with
 * ODIN_HOME_DIR=<odin folder>, which is what the hooks key on, so Claude run
 * on the server outside Odin is untouched.
 */

export interface RemoteAgentFile {
	/** Absolute path on the server. */
	path: string;
	content: string;
	mode: number;
}

/** Where Odin installs Claude Code when the server has none on PATH. */
export function remoteClaudeCodeDir(odinFolder: string): string {
	return `${odinFolder}/claude-code`;
}

export function remoteClaudeFallbackPath(odinFolder: string): string {
	return `${remoteClaudeCodeDir(odinFolder)}/claude`;
}

export function buildRemoteAgentFiles(odinFolder: string): RemoteAgentFile[] {
	const hooks = `${odinFolder}/hooks`;
	const binDir = `${odinFolder}/bin`;
	return [
		{
			path: `${hooks}/${NOTIFY_SCRIPT_NAME}`,
			content: getNotifyScriptContent(),
			mode: 0o755,
		},
		{
			path: `${hooks}/${SUBAGENT_CAP_SCRIPT_NAME}`,
			content: getSubagentCapScriptContent(),
			mode: 0o755,
		},
		{
			path: `${hooks}/${SHELL_RULE_SCRIPT_NAME}`,
			content: getShellRuleScriptContent(),
			mode: 0o755,
		},
		{
			// Sessions get <odin folder>/bin first on PATH; the wrapper exports
			// ODIN_AGENT_ID (which the server records hook states under) and
			// execs the server's own claude, or the copy Odin installed.
			path: `${binDir}/claude`,
			content: buildWrapperScript("claude", `exec "$REAL_BIN" "$@"`, {
				agentId: "claude",
				binDir,
				fallbackBin: remoteClaudeFallbackPath(odinFolder),
			}),
			mode: 0o755,
		},
	];
}

/**
 * The server's ~/.claude/settings.json with Odin's hooks merged in, or null
 * when it holds something other than a JSON object (left alone, like the
 * laptop's).
 */
export function mergeRemoteClaudeSettings(
	existingText: string,
	odinFolder: string,
): string | null {
	const existing = parseClaudeSettingsJson(existingText);
	if (!existing) return null;
	const merged = mergeClaudeManagedSettings(
		existing,
		`${odinFolder}/hooks/${NOTIFY_SCRIPT_NAME}`,
	);
	return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Install Claude Code with the odin folder's Node when the server has no
 * `claude` of its own, plus a launcher the wrapper falls back to. A no-op once
 * installed, or whenever the login shell finds a claude.
 */
export function buildClaudeInstallCommand(odinFolder: string): string {
	const dir = remoteClaudeCodeDir(odinFolder);
	const node = `${odinFolder}/node/bin`;
	const launcher = remoteClaudeFallbackPath(odinFolder);
	const q = shellQuote;
	const script = `#!/bin/sh\nexport PATH=${q(node)}:"$PATH"\nexec ${q(`${dir}/node_modules/.bin/claude`)} "$@"\n`;
	return [
		`if ! bash -lc 'command -v claude' >/dev/null 2>&1 && [ ! -x ${q(launcher)} ]; then`,
		`mkdir -p ${q(dir)} &&`,
		`PATH=${q(node)}:"$PATH" npm install --prefix ${q(dir)} --no-audit --no-fund --loglevel=error @anthropic-ai/claude-code &&`,
		`printf '%s' ${q(script)} > ${q(launcher)} && chmod 755 ${q(launcher)};`,
		"fi",
	].join(" ");
}
