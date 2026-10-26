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

/**
 * Until when this computer's plan is out, epoch seconds, from claude-auto's
 * ~/.claude/plan-limit.json; 0 when it isn't. The host's sessions run on the
 * same plan, so a limit hit here holds there too.
 */
export function planLimitedUntil(
	read: () => string = () =>
		readFileSync(join(homedir(), ".claude", "plan-limit.json"), "utf8"),
): number {
	try {
		const until = Number(JSON.parse(read()).until);
		return Number.isFinite(until) ? until : 0;
	} catch {
		return 0;
	}
}
