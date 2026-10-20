import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether host sessions move to ANTHROPIC_API_KEY at the plan limit. The
 * Settings switch wins; never touched, it follows this computer: on when
 * claude-auto's plan-limit hook is in ~/.claude/settings.json, so the host
 * falls back to the key the way this computer does.
 */
export function apiKeyFallbackOn(
	setting: boolean | undefined,
	claudeSettings: string = readClaudeSettings(),
): boolean {
	return setting ?? claudeSettings.includes("plan-limit.py");
}

function readClaudeSettings(): string {
	try {
		return readFileSync(join(homedir(), ".claude", "settings.json"), "utf8");
	} catch {
		return "";
	}
}
