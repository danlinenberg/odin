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
