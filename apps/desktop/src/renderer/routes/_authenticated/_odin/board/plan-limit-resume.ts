import { LIMIT_HIT_RE } from "shared/limit-hit";

/** What a session resumed on the API key opens with, as on the remote host. */
export const PLAN_LIMIT_OPENING = "Continue where you left off.";

/**
 * Whether a local session whose turn just failed should restart on the API
 * key: its last reply is the plan's limit line ("You've hit your ... limit",
 * which only the claude.ai login prints) and claude-auto's hook has the key
 * on until `until` (epoch seconds). Returns the key that marks this restart
 * done - one per pane per limit, so a restart that comes back on the plan
 * (Odin's Claude command isn't claude-auto) fails once and stays put.
 */
export function planLimitResumeKey(
	paneId: string,
	lastReply: { role: string; text: string } | undefined,
	until: number,
	nowSeconds: number,
): string | null {
	if (until <= nowSeconds) return null;
	if (lastReply?.role !== "assistant" || !LIMIT_HIT_RE.test(lastReply.text))
		return null;
	return `${paneId}:${until}`;
}
