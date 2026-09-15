/**
 * Which checkouts the typed text could mean. Picking from the `<datalist>`
 * fills in the whole path (the exact case); typing "odin" and hitting ⌘⏎
 * without opening the popup is the case that would otherwise be ignored.
 *
 * More than one hit is left ambiguous on purpose — the dialog says how many
 * rather than guessing which repo you meant.
 */
export function matchRepos(repos: string[], query: string): string[] {
	const text = query.trim().toLowerCase();
	if (!text) return [];
	const exact = repos.find((path) => path.toLowerCase() === text);
	if (exact) return [exact];
	// A match on the repo's own name wins, so "odin" doesn't go ambiguous over
	// every checkout that merely lives under a directory of that name.
	const byName = repos.filter(
		(path) => path.split("/").pop()?.toLowerCase() === text,
	);
	if (byName.length > 0) return byName;
	const words = text.split(/\s+/);
	return repos.filter((path) =>
		words.every((word) => path.toLowerCase().includes(word)),
	);
}

/** Short label for a checkout: `<parent>/<name>`. */
export function repoLabel(path: string): string {
	return path.split("/").slice(-2).join("/");
}
