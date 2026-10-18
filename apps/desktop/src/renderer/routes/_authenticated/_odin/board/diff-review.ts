import type { SelectedLineRange } from "@pierre/diffs/react";

type Side = "additions" | "deletions";

/** One line of a file's patch, with its number on each side it exists on. */
type PatchRow = {
	kind: "+" | "-" | " ";
	old?: number;
	new?: number;
	text: string;
};

/** The diff of everything the branch did since it left main, picked in the header. */
export const BRANCH = "branch";

/** A comment on lines of the diff, kept until the review goes to the agent. */
export type ReviewComment = {
	id: string;
	/** The PR the diff came from; null is the working tree, BRANCH the branch. */
	pr: string | null;
	path: string;
	/** Where the comment shows - under the last line of the range. */
	side: Side;
	lineNumber: number;
	/** `path:12-14`, or the old lines when only removed lines are picked. */
	location: string;
	/** The lines as they stood when the comment was written, `+`/`-`/` ` first. */
	code: string[];
	text: string;
	/** Already typed into the session - kept, grayed, to check the fix against. */
	sent?: boolean;
};

export function patchRows(patch: string): PatchRow[] {
	const rows: PatchRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	for (const line of patch.split("\n")) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		const kind = line[0];
		const text = line.slice(1);
		if (kind === "+") rows.push({ kind, new: newLine++, text });
		else if (kind === "-") rows.push({ kind, old: oldLine++, text });
		else if (kind === " ")
			rows.push({ kind, old: oldLine++, new: newLine++, text });
		else if (kind !== "\\") inHunk = false;
	}
	return rows;
}

function rowIndex(rows: PatchRow[], side: Side, lineNumber: number): number {
	return rows.findIndex((row) =>
		side === "additions" ? row.new === lineNumber : row.old === lineNumber,
	);
}

function span(numbers: number[]): string {
	const first = numbers[0];
	const last = numbers[numbers.length - 1];
	return first === last ? `${first}` : `${first}-${last}`;
}

/** The comment's anchor, location and quoted code for a range picked in the gutter. */
export function commentTarget(
	patch: string,
	path: string,
	range: SelectedLineRange,
): Pick<ReviewComment, "side" | "lineNumber" | "location" | "code"> {
	const startSide = range.side ?? "additions";
	const endSide = range.endSide ?? startSide;
	const rows = patchRows(patch);
	const a = rowIndex(rows, startSide, range.start);
	const b = rowIndex(rows, endSide, range.end);
	const picked =
		a < 0 || b < 0 ? [] : rows.slice(Math.min(a, b), Math.max(a, b) + 1);
	const last = a > b ? { side: startSide, lineNumber: range.start } : null;
	const newLines = picked.flatMap((row) => row.new ?? []);
	const oldLines = picked.flatMap((row) => row.old ?? []);
	const location = newLines.length
		? `${path}:${span(newLines)}`
		: oldLines.length
			? `${path} (removed, old lines ${span(oldLines)})`
			: `${path}:${range.end}`;
	return {
		side: last?.side ?? endSide,
		lineNumber: last?.lineNumber ?? range.end,
		location,
		code: picked.map((row) => `${row.kind} ${row.text}`),
	};
}

/** The one message the whole review goes to the agent as. */
export function reviewMessage(
	comments: ReviewComment[],
	pr: string | null,
): string {
	const where =
		pr === BRANCH
			? "this branch's diff against its base branch"
			: pr
				? `the diff of ${pr}`
				: "the working tree diff";
	const items = comments.map((comment, index) => {
		const code = comment.code.map((line) => `   | ${line}`);
		const text = comment.text.split("\n").map((line) => `   ${line}`);
		return [`${index + 1}. ${comment.location}`, ...code, ...text].join("\n");
	});
	return [
		`Review comments on ${where}. Fix each one, or tell me why not:`,
		...items,
	].join("\n\n");
}
