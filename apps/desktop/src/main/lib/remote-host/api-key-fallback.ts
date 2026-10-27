import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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

const PLAN_LIMIT_FILE = join(homedir(), ".claude", "plan-limit.json");

function readPlanLimitFile(): string {
	return readFileSync(PLAN_LIMIT_FILE, "utf8");
}

/**
 * Until when this computer's plan is out, epoch seconds, from claude-auto's
 * ~/.claude/plan-limit.json; 0 when it isn't. The host's sessions run on the
 * same plan, so a limit hit here holds there too.
 */
export function planLimitedUntil(
	read: () => string = readPlanLimitFile,
): number {
	try {
		const until = Number(JSON.parse(read()).until);
		return Number.isFinite(until) ? until : 0;
	} catch {
		return 0;
	}
}

/** Why and until when claude-auto keeps this computer's sessions on the API key. */
export interface PlanLimit {
	/** Epoch seconds. */
	until: number;
	/** The limit line Claude printed, e.g. "You've hit your weekly limit". */
	reason: string;
}

/**
 * claude-auto's plan-limit note while it is in effect; null when there is
 * none, it can't be read, or its `until` has passed (claude-auto drops it on
 * the next launch then, so sessions start on the plan again).
 */
export function activePlanLimit(
	nowSeconds: number = Date.now() / 1000,
	read: () => string = readPlanLimitFile,
): PlanLimit | null {
	try {
		const note = JSON.parse(read());
		const until = Number(note?.until);
		if (!Number.isFinite(until) || until <= nowSeconds) return null;
		return {
			until,
			reason: typeof note.reason === "string" ? note.reason.trim() : "",
		};
	} catch {
		return null;
	}
}

/** What `claude-auto --use-plan` does: drop the note, so the next launch runs on the plan. */
export async function clearPlanLimit(): Promise<void> {
	await rm(PLAN_LIMIT_FILE, { force: true });
}
