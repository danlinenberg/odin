/**
 * Does this session run inside Odin's own checkout? Worktrees under it count:
 * they are the same repo, and `.worktrees/` lives inside the checkout.
 */
export function isOdinCwd(
	cwd: string,
	odinRepoPath: string | null | undefined,
): boolean {
	return (
		!!odinRepoPath &&
		(cwd === odinRepoPath || cwd.startsWith(`${odinRepoPath}/`))
	);
}

/**
 * Every tag a card can carry, and the only ones it may. Deliberately short:
 * with a dozen of them each pill matched two cards and the filter bar was
 * longer than the columns. Picked by the
 * brief writer or by hand.
 */
export const TAG_VOCABULARY = [
	// Stamped by the automation runner, so a card that appeared while you were
	// away says why it's there. Also pickable by hand.
	"automation",
	"bug",
	"feature",
	"chore",
	"docs",
	"infra",
] as const;

/** The full board set — what the tag menu offers. */
export const BOARD_TAGS: string[] = [...TAG_VOCABULARY];

/**
 * Drop anything off the list. Sessions tagged under the old, longer vocabulary
 * keep #perf/#ui/#api/… in app-state; this is where they stop being shown,
 * rather than a migration over persisted state. `custom` is the tags you added
 * by hand from the tag menu — on the list because you put them there.
 */
export function boardTags(
	tags: string[] | undefined,
	custom: readonly string[] = [],
): string[] {
	return (tags ?? []).filter(
		(tag) => BOARD_TAGS.includes(tag) || custom.includes(tag),
	);
}

/** A typed tag, cleaned: "#My Tag " → "my-tag". Empty when nothing's left. */
export function normalizeTag(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/^#+/, "")
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9_-]/g, "");
}
