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
 * Claude Code's own commands, which no skills folder lists. The chat view's
 * menu offers them beside the skills, so /compact is a match of its own and
 * not a skill that mentions "compact" in its description.
 */
export const BUILT_IN_COMMANDS = [
	{
		name: "compact",
		description: "Summarize the conversation to free up context",
	},
	{ name: "clear", description: "Start the conversation over" },
	{ name: "context", description: "Show how much context is used" },
	{ name: "model", description: "Change the model" },
	{ name: "cost", description: "Show what this session has cost" },
	{ name: "btw", description: "Ask a side question without interrupting" },
	{ name: "resume", description: "Resume an earlier conversation" },
	{ name: "rewind", description: "Go back to an earlier point" },
	{ name: "review", description: "Review a pull request" },
	{ name: "memory", description: "Edit the memory files" },
	{ name: "mcp", description: "Manage MCP servers and sign in to them" },
	{ name: "status", description: "Show the session's status" },
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
