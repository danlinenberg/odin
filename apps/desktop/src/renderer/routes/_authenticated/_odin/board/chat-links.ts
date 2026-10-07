const PR_URL =
	/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/(\d+)/g;
const JIRA_URL =
	/https:\/\/[\w.-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/g;

/**
 * "#676" and "CRR-851" this session has a URL for - a PR it opened or listed,
 * a ticket it fetched. Only these get linked: a bare number with no URL behind
 * it in the conversation could be any repo's.
 */
export function collectRefs(texts: string[]): Map<string, string> {
	const refs = new Map<string, string>();
	for (const text of texts) {
		for (const [url, number] of text.matchAll(PR_URL))
			refs.set(`#${number}`, url);
		for (const [url, key] of text.matchAll(JIRA_URL))
			refs.set(key as string, url);
	}
	return refs;
}

/** Code, existing markdown links and raw URLs - left exactly as written. */
const KEEP = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/g;
const REF = /(?:\bPR\s+)?#(\d+)\b|\b([A-Z][A-Z0-9]+-\d+)\b/g;

/** Turn known refs in Claude's markdown into links. */
export function linkify(text: string, refs: Map<string, string>): string {
	if (refs.size === 0) return text;
	return text
		.split(KEEP)
		.map((part, index) =>
			// split() with one capture group puts the kept parts at odd indexes.
			index % 2 === 1
				? part
				: part.replace(REF, (match, number?: string, key?: string) => {
						const url = refs.get(number ? `#${number}` : (key ?? ""));
						return url ? `[${match}](${url})` : match;
					}),
		)
		.join("");
}
