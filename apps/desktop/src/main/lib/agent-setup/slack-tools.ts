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
