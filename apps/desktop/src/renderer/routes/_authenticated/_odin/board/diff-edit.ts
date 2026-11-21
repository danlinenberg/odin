/**
 * Whether the Diff tab offers Edit on a file. Only the working tree's own
 * changes are on disk to edit: the branch's commits, a PR and the last commit
 * are history, read-only. A deleted or binary file has no text to edit.
 */
export function canEditDiffFile(
	choice: string | null,
	source: string | undefined,
	file: { binary: boolean; patch: string } | undefined,
): boolean {
	if (choice !== null || !file || file.binary) return false;
	if (source !== "uncommitted changes" && source !== "since review")
		return false;
	return !/^\+\+\+ \/dev\/null$/m.test(file.patch);
}
