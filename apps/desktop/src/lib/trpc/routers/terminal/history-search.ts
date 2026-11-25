import { activeProfileId } from "../odin-config";

/**
 * Task History's search (searchSessions) with the names the board knew each
 * session by and the profile's own sessions only - for the board's search and
 * for a page asking which sessions worked on it (/sessions/for-url).
 */
export async function historySearch(input: {
	query: string;
	limit: number;
	cursor?: number;
	profileId?: string;
}) {
	const { cachedBriefs, searchSessions } = await import(
		"main/lib/claude-sessions"
	);
	const { cardTitles } = await import("main/lib/card-titles");
	const { profileHistory } = await import("./session-people");
	// The name the board knew it by (a rename, kept after the card closes),
	// else the brief's title - same order as Insights.
	const titles: Record<string, string> = {};
	for (const [id, brief] of await cachedBriefs())
		if (brief.title) titles[id] = brief.title;
	Object.assign(titles, cardTitles());
	return searchSessions({
		query: input.query,
		limit: input.limit,
		cursor: input.cursor ?? 0,
		titles,
		...profileHistory(input.profileId ?? activeProfileId()),
	});
}
