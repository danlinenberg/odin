/**
 * Pure bits of the chat reply box's `@` file picker. Claude Code reads a file
 * named as `@path` in a prompt, so the picker only fills in the path.
 */

/** An `@` token being typed at the end of the reply. */
const FILE_TOKEN = /(?:^|\s)@([^\s@"]*)$/;

/** The path typed after `@`, or undefined when the picker shouldn't be open. */
export function fileToken(text: string): string | undefined {
	return FILE_TOKEN.exec(text)?.[1];
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Every character of `query`, in order, somewhere in `text`. */
function inOrder(text: string, query: string): boolean {
	let at = 0;
	for (const char of query) {
		at = text.indexOf(char, at);
		if (at < 0) return false;
		at += 1;
	}
	return true;
}

/**
 * How well a path fits the typed text, lower is better, or undefined when it
 * doesn't. A file whose name starts with the text beats one whose name holds
 * it, which beats a folder match, which beats the letters spread along the name.
 */
function rank(path: string, query: string): number | undefined {
	if (!query) return 0;
	const lower = path.toLowerCase();
	const name = baseName(lower);
	if (name.startsWith(query)) return 0;
	if (name.includes(query)) return 1;
	if (lower.startsWith(query)) return 2;
	if (lower.includes(query)) return 3;
	if (inOrder(name, query)) return 4;
	return undefined;
}

const depth = (path: string) => path.split("/").length;

/**
 * Paths matching the typed text, best first. Within a rank, a file nearer the
 * root comes first, then the shorter path, then A to Z.
 */
export function matchFiles(
	files: string[],
	token: string,
	limit = 50,
): string[] {
	const query = token.toLowerCase();
	const ranked: { path: string; score: number }[] = [];
	for (const path of files) {
		const score = rank(path, query);
		if (score !== undefined) ranked.push({ path, score });
	}
	return ranked
		.sort(
			(a, b) =>
				a.score - b.score ||
				depth(a.path) - depth(b.path) ||
				a.path.length - b.path.length ||
				a.path.localeCompare(b.path),
		)
		.slice(0, limit)
		.map((item) => item.path);
}

/**
 * Replace the `@` token being typed with the picked path and a space. A path
 * with a space in it goes in quotes, as Claude Code's own picker writes it.
 */
export function insertFile(text: string, path: string): string {
	const mention = /\s/.test(path) ? `@"${path}"` : `@${path}`;
	return text.replace(/@[^\s@"]*$/, `${mention} `);
}
