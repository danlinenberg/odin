/**
 * The files you marked as reviewed in the diff view, like GitHub's Viewed
 * checkbox. A mark remembers the patch the file had when you ticked it, so a
 * push that touches the file clears its mark and the file asks for another
 * look; the others stay ticked.
 *
 * Kept per session on the machine, next to the review comments: closing the
 * drawer or restarting the app keeps what you ticked. Marks are pruned to the
 * files of the diff on each save and the key goes when nothing is ticked, so
 * a session never holds more than its own diff's files.
 */

/** `<diff>\n<path>` -> the mark of the patch that was reviewed. */
export type ReviewedMarks = Record<string, string>;

type MarkedFile = { path: string; patch: string };

/** The diff a mark belongs to: the working tree, the branch, or a PR. */
function diffKey(pr: string | null): string {
	return pr ?? "work";
}

export function markKey(pr: string | null, path: string): string {
	return `${diffKey(pr)}\n${path}`;
}

/** A short fingerprint of a file's patch: the same patch, the same mark. */
export function patchMark(patch: string): string {
	let hash = 5381;
	for (let i = 0; i < patch.length; i++)
		hash = ((hash << 5) + hash + patch.charCodeAt(i)) | 0;
	return `${patch.length}:${(hash >>> 0).toString(36)}`;
}

/** Ticked, and the file's patch is still the one that was reviewed. */
export function isReviewed(
	marks: ReviewedMarks,
	pr: string | null,
	file: MarkedFile,
): boolean {
	return marks[markKey(pr, file.path)] === patchMark(file.patch);
}

/** Tick a file, or untick it when its current patch is already ticked. */
export function toggleReviewed(
	marks: ReviewedMarks,
	pr: string | null,
	file: MarkedFile,
): ReviewedMarks {
	const key = markKey(pr, file.path);
	const next = { ...marks };
	if (isReviewed(marks, pr, file)) delete next[key];
	else next[key] = patchMark(file.patch);
	return next;
}

/** How many of `files` are ticked with their current patch. */
export function reviewedCount(
	marks: ReviewedMarks,
	pr: string | null,
	files: MarkedFile[],
): number {
	return files.filter((file) => isReviewed(marks, pr, file)).length;
}

/**
 * Only this diff's current files keep a mark; a renamed or dropped file, or
 * a file whose patch changed, is forgotten. Other diffs of the session
 * (another PR, the branch) are left as they are.
 */
export function pruneMarks(
	marks: ReviewedMarks,
	pr: string | null,
	files: MarkedFile[],
): ReviewedMarks {
	const prefix = `${diffKey(pr)}\n`;
	const keep = new Set(
		files
			.filter((file) => isReviewed(marks, pr, file))
			.map((file) => markKey(pr, file.path)),
	);
	return Object.fromEntries(
		Object.entries(marks).filter(
			([key]) => !key.startsWith(prefix) || keep.has(key),
		),
	);
}

/** The first file after `from` that is not ticked, wrapping round; -1 when all are. */
export function nextUnreviewed(
	marks: ReviewedMarks,
	pr: string | null,
	files: MarkedFile[],
	from: number,
): number {
	for (let step = 1; step <= files.length; step++) {
		const index = (from + step) % files.length;
		if (!isReviewed(marks, pr, files[index])) return index;
	}
	return -1;
}

export function reviewedStorageKey(paneId: string): string {
	return `odin:diff-reviewed:${paneId}`;
}

export function loadMarks(paneId: string): ReviewedMarks {
	try {
		const raw = localStorage.getItem(reviewedStorageKey(paneId));
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function saveMarks(paneId: string, marks: ReviewedMarks): void {
	try {
		const key = reviewedStorageKey(paneId);
		if (Object.keys(marks).length)
			localStorage.setItem(key, JSON.stringify(marks));
		else localStorage.removeItem(key);
	} catch {}
}
