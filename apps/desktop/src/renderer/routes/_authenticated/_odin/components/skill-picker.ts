/**
 * Pure bits of the session composer's skill picker (see OdinPromptDialog).
 */

/** A slash token being typed at the end of the prompt. */
const SKILL_TOKEN = /(?:^|\s)\/([\w:-]*)$/;

/** The token under the caret, or undefined when the picker shouldn't be open. */
export function skillToken(prompt: string): string | undefined {
	return SKILL_TOKEN.exec(prompt)?.[1];
}

/**
 * Skills matching the typed token: name matches first, then description matches
 * (so "billing" finds a skill that never says billing in its name).
 */
export function matchSkills<T extends { name: string; description: string }>(
	skills: T[],
	token: string,
	limit = 8,
): T[] {
	const query = token.toLowerCase();
	const byName = (skill: T) => skill.name.toLowerCase().includes(query);
	return skills
		.filter(
			(skill) =>
				byName(skill) || skill.description.toLowerCase().includes(query),
		)
		.sort((a, b) => Number(byName(b)) - Number(byName(a)))
		.slice(0, limit);
}

/**
 * Claude Code's own commands (as of 2.1.323), which no skills folder lists.
 * Bundled skills like /init and /loop are in BUNDLED_SKILLS instead. The
 * chat view's menu offers them beside the skills, so /compact is a match of its own and
 * not a skill that mentions "compact" in its description.
 */
export const BUILT_IN_COMMANDS = [
	{
		name: "compact",
		description: "Summarize the conversation to free up context",
	},
	{ name: "clear", description: "Start the conversation over" },
	{
		name: "plan",
		description: "Plan first: Claude reads and proposes before it edits",
	},
	{ name: "context", description: "Show how much context is used" },
	{ name: "model", description: "Change the model" },
	{ name: "effort", description: "Set the effort level" },
	{
		name: "cost",
		description: "Show what this session has cost (same as /usage)",
	},
	{
		name: "usage",
		description: "Show session cost, plan usage and activity stats",
	},
	{ name: "btw", description: "Ask a side question without interrupting" },
	{ name: "resume", description: "Resume an earlier conversation" },
	{
		name: "rewind",
		description: "Go back to an earlier point in code or conversation",
	},
	{ name: "branch", description: "Branch the conversation at this point" },
	{
		name: "fork",
		description: "Copy this conversation into a new background session",
	},
	{
		name: "subtask",
		description: "Send a subagent off with your full context",
	},
	{ name: "goal", description: "Set a goal Claude checks before stopping" },
	{ name: "memory", description: "Edit the memory files" },
	{ name: "mcp", description: "Manage MCP servers and sign in to them" },
	{ name: "permissions", description: "Manage allow and deny rules for tools" },
	{ name: "hooks", description: "View hook settings for tool events" },
	{ name: "agents", description: "Manage subagents" },
	{ name: "skills", description: "List the available skills" },
	{ name: "plugin", description: "Manage Claude Code plugins" },
	{
		name: "reload-plugins",
		description: "Activate plugin changes in this session",
	},
	{ name: "reload-skills", description: "Pick up skills changed on disk" },
	{ name: "add-dir", description: "Add a working directory" },
	{ name: "cd", description: "Move this session to another directory" },
	{ name: "diff", description: "Show the changes made in this session" },
	{
		name: "export",
		description: "Export the conversation to a file or clipboard",
	},
	{ name: "copy", description: "Copy Claude's last response" },
	{ name: "rename", description: "Rename the conversation" },
	{ name: "recap", description: "Write a one-line recap of the session" },
	{ name: "tasks", description: "View and manage background tasks" },
	{ name: "loops", description: "List, create and delete loops" },
	{ name: "workflows", description: "Browse running and finished workflows" },
	{ name: "todos", description: "Show the current to-do list" },
	{
		name: "autofix-pr",
		description: "Watch the current PR and fix its issues",
	},
	{ name: "ultraplan", description: "Plan with a cloud session" },
	{
		name: "ultrareview",
		description: "Deep review of the branch in the cloud",
	},
	{
		name: "advisor",
		description: "Let Claude consult a stronger model at key moments",
	},
	{ name: "fast", description: "Toggle fast mode" },
	{ name: "brief", description: "Toggle brief-only mode" },
	{ name: "focus", description: "Toggle focus view" },
	{ name: "output-style", description: "Switch the output style" },
	{ name: "config", description: "Open settings" },
	{ name: "status", description: "Show the session's status" },
	{ name: "doctor", description: "Check the setup and fix problems" },
	{ name: "debug", description: "Turn on debug logging for this session" },
	{ name: "sandbox", description: "Set up the Bash sandbox" },
	{ name: "statusline", description: "Set up the status line" },
	{
		name: "terminal-setup",
		description: "Set up terminal keys like Shift+Enter",
	},
	{ name: "keybindings", description: "Open the keyboard shortcuts file" },
	{ name: "theme", description: "Change the theme" },
	{ name: "color", description: "Set the prompt bar color" },
	{ name: "ide", description: "Manage IDE integrations" },
	{
		name: "install-github-app",
		description: "Set up Claude GitHub Actions for a repo",
	},
	{ name: "install-slack-app", description: "Install the Claude Slack app" },
	{
		name: "remote-control",
		description: "Control this session from your phone or claude.ai",
	},
	{
		name: "teleport",
		description: "Send this session to the cloud, or resume one",
	},
	{ name: "remote-env", description: "Choose the default cloud environment" },
	{ name: "web-setup", description: "Set up cloud sessions with GitHub" },
	{ name: "desktop", description: "Continue this session in Claude Desktop" },
	{ name: "mobile", description: "Show a QR code for the mobile app" },
	{ name: "insights", description: "Report on your Claude Code sessions" },
	{ name: "release-notes", description: "Show the release notes" },
	{ name: "feedback", description: "Send feedback or report a bug" },
	{ name: "privacy-settings", description: "View and change privacy settings" },
	{ name: "login", description: "Sign in" },
	{ name: "logout", description: "Sign out" },
	{ name: "version", description: "Show the Claude Code version" },
	{ name: "exit", description: "Exit Claude Code" },
	{ name: "help", description: "Show the commands" },
];

/**
 * Enter picks a suggestion only when its name matches what you typed. A match
 * on its description alone sends your own text: "/compact" stays /compact.
 */
export const enterPicks = (name: string, token: string): boolean =>
	name.toLowerCase().includes(token.toLowerCase());

/** Replace the token being typed with the chosen skill's slash command. */
export function insertSkill(prompt: string, name: string): string {
	return prompt.replace(/\/[\w:-]*$/, `/${name} `);
}

/**
 * The skill being typed into a task's title: a `/token` that is all of the
 * first line so far, after any priority "!"s. A task's skill is the leading
 * `/name` only, so a slash later in the title is text, not a command.
 */
export function taskSkillToken(text: string): string | undefined {
	const first = text.split("\n")[0] ?? "";
	return /^\s*!*\s*\/([\w:-]*)$/.exec(first)?.[1];
}

/**
 * The first line with the typed token swapped for the picked skill, plus a
 * space so the title follows on. The brief below it is left alone.
 */
export function completeTaskSkill(text: string, name: string): string {
	const [first = "", ...rest] = text.split("\n");
	return [first.replace(/\/[\w:-]*$/, `/${name} `), ...rest].join("\n");
}
