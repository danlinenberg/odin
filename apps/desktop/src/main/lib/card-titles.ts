import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "./app-environment";

/**
 * The last name each session's card had, by Claude session id. A card's title
 * lives on its pane, and the pane goes when the card closes - so a finished
 * task lost the name the board knew it by. Every board save records the
 * titles here; a closed card keeps its last one.
 */
const titlesPath = () => join(ODIN_HOME_DIR, "card-titles.json");

export function cardTitles(path = titlesPath()): Record<string, string> {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

export function rememberCardTitles(
	panes: Record<string, { claudeSessionId?: string; odinTaskTitle?: string }>,
	path = titlesPath(),
): void {
	const saved = cardTitles(path);
	let changed = false;
	for (const { claudeSessionId, odinTaskTitle } of Object.values(panes)) {
		if (!claudeSessionId || !odinTaskTitle) continue;
		if (saved[claudeSessionId] === odinTaskTitle) continue;
		saved[claudeSessionId] = odinTaskTitle;
		changed = true;
	}
	if (!changed) return;
	// A full disk loses a rename, not the board save that carried it.
	try {
		writeFileSync(path, JSON.stringify(saved));
	} catch (error) {
		console.warn("[card-titles] not saved:", error);
	}
}
