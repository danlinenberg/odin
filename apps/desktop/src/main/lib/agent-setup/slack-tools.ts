/**
 * Slack tools a session must never call: each posts a message as the user,
 * carries Odin's footer and can't be taken back. Denied in Claude's settings,
 * on this computer and on remote hosts - a deny rule holds even under
 * --dangerously-skip-permissions.
 */
export const SLACK_SEND_TOOLS = [
	"mcp__plugin_slack_slack__slack_send_message",
	"mcp__claude_ai_Slack__slack_send_message",
];

/** Scheduled sends post later as the user - blocked like a send. */
const SLACK_SCHEDULE_TOOLS = [
	"mcp__plugin_slack_slack__slack_schedule_message",
	"mcp__claude_ai_Slack__slack_schedule_message",
];

export const SLACK_DENY_RULES = [...SLACK_SEND_TOOLS, ...SLACK_SCHEDULE_TOOLS];

/** Each send tool's `_draft` twin: allowed so drafts stay prompt-free. */
export const SLACK_ALLOW_RULES = SLACK_SEND_TOOLS.map(
	(tool) => `${tool}_draft`,
);

/**
 * Claude's permission lists with Odin's Slack rules applied: the send and
 * schedule tools denied unless `allowSend`, the draft tools always allowed.
 * Allowing takes back only Odin's own deny rules; anything else stays.
 */
export function withSlackRules(
	permissions: { deny?: unknown; allow?: unknown },
	allowSend: boolean,
): { deny: unknown[]; allow: unknown[] } {
	const list = (value: unknown) => (Array.isArray(value) ? value : []);
	const deny = list(permissions.deny).filter(
		(rule) => !SLACK_DENY_RULES.includes(rule),
	);
	return {
		deny: allowSend ? deny : [...deny, ...SLACK_DENY_RULES],
		allow: [...new Set([...list(permissions.allow), ...SLACK_ALLOW_RULES])],
	};
}
