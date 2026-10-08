/** Which connector reads a link, and what it needs - see read-link.ts. */
export type LinkKind =
	| { kind: "slack"; url: string }
	| { kind: "github"; repo: string; number: string }
	| { kind: "jira"; key: string }
	| { kind: "notion"; id: string }
	| { kind: "clickup"; id: string; teamId?: string };

export function linkKind(url: string): LinkKind | null {
	if (/slack\.com\/archives\//.test(url)) return { kind: "slack", url };
	const github = /github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(
		url,
	);
	if (github) return { kind: "github", repo: github[1], number: github[2] };
	// A bare key, a /browse/ link, or a board link with ?selectedIssue=.
	const jira =
		/^([A-Z][A-Z0-9]+-\d+)$/.exec(url) ??
		(/atlassian\.net\//.test(url)
			? /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(url)
			: null);
	if (jira) return { kind: "jira", key: jira[1] };
	// app.clickup.com/t/<id>, or /t/<teamId>/<CUSTOM-ID> for a custom task id.
	const clickup = /clickup\.com\/t\/(?:(\d+)\/)?([\w-]+)/.exec(url);
	if (clickup)
		return clickup[1]
			? { kind: "clickup", id: clickup[2], teamId: clickup[1] }
			: { kind: "clickup", id: clickup[2] };
	if (/notion\.(?:so|site|com)\//.test(url)) {
		// A peeked row (?p=) names its page there; otherwise the id ends the
		// path, after a dashed title whose own hex letters must not leak in.
		const parsed = new URL(url);
		const where = (parsed.searchParams.get("p") ?? parsed.pathname).replace(
			/-/g,
			"",
		);
		const id = /([0-9a-f]{32})(?![0-9a-f])/.exec(where);
		if (id) return { kind: "notion", id: id[1] };
	}
	return null;
}
