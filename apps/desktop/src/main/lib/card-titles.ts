import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profileOf } from "shared/odin-profile";
import { ODIN_HOME_DIR } from "./app-environment";

/**
 * The last name each session's card had, by Claude session id. A card's title
 * lives on its pane, and the pane goes when the card closes - so a finished
 * task lost the name the board knew it by. Every board save records the
 * titles here; a closed card keeps its last one.
 *
 * The card's profile is kept the same way, beside it: Session History shows
 * only the active profile's sessions, and a plain session (not launched off a
 * feed, so not in the work log) has no other record of its profile once the
 * card closes.
 */
const titlesPath = () => join(ODIN_HOME_DIR, "card-titles.json");
const profilesPath = () => join(ODIN_HOME_DIR, "card-profiles.json");

type CardPane = {
	claudeSessionId?: string;
	odinTaskTitle?: string;
	odinProfile?: string;
};

function readMap(path: string): Record<string, string> {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

/** Adds the panes' values to the file at `path`; a closed card keeps its last. */
function remember(
	panes: Record<string, CardPane>,
	path: string,
	pick: (pane: CardPane) => string | undefined,
): void {
	const saved = readMap(path);
	let changed = false;
	for (const pane of Object.values(panes)) {
		const value = pick(pane);
		if (!pane.claudeSessionId || !value) continue;
		if (saved[pane.claudeSessionId] === value) continue;
		saved[pane.claudeSessionId] = value;
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

export function cardTitles(path = titlesPath()): Record<string, string> {
	return readMap(path);
}

export function cardProfiles(path = profilesPath()): Record<string, string> {
	return readMap(path);
}

export function rememberCardTitles(
	panes: Record<string, CardPane>,
	path = titlesPath(),
	profilePath = profilesPath(),
): void {
	remember(panes, path, (pane) => pane.odinTaskTitle);
	remember(panes, profilePath, (pane) => profileOf(pane.odinProfile));
}
