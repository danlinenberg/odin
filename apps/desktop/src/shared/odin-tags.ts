/**
 * #odin for any session running inside Odin's own checkout, whichever view
 * launched it. The rail's "Work on Odin" passes the tag explicitly, but the
 * board's New Session repo picker doesn't — deriving it from the session cwd
 * covers every entry point, worktrees included.
 */
export function withOdinTag(
	tags: string[] | undefined,
	cwd: string,
	odinRepoPath: string | null | undefined,
): string[] | undefined {
	const inOdin =
		!!odinRepoPath &&
		(cwd === odinRepoPath || cwd.startsWith(`${odinRepoPath}/`));
	if (!inOdin) return tags;
	return tags?.includes("odin") ? tags : [...(tags ?? []), "odin"];
}

/**
 * Every tag a card can carry, and the only ones it may. Deliberately short:
 * with a dozen of them each pill matched two cards and the filter bar was
 * longer than the columns. #odin is derived from the cwd (above), the rest are
 * picked by the brief writer or by hand.
 */
export const TAG_VOCABULARY = [
	"bug",
	"feature",
	"chore",
	"docs",
	"infra",
] as const;

/** The full board set — what the tag menu offers. */
export const BOARD_TAGS: string[] = ["odin", ...TAG_VOCABULARY];

/**
 * Drop anything off the list. Sessions tagged under the old, longer vocabulary
 * keep #perf/#ui/#api/… in app-state; this is where they stop being shown,
 * rather than a migration over persisted state.
 */
export function boardTags(tags: string[] | undefined): string[] {
	return (tags ?? []).filter((tag) => BOARD_TAGS.includes(tag));
}
