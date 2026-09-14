/**
 * Pure bits of the session composer's skill picker (see OdinPromptDialog).
 * ponytail: the menu only opens on a slash token at the END of the text —
 * mid-text insertion isn't supported, nobody composes that way.
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

/** Replace the token being typed with the chosen skill's slash command. */
export function insertSkill(prompt: string, name: string): string {
	return prompt.replace(/\/[\w:-]*$/, `/${name} `);
}
