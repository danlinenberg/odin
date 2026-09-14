/** A work_log row's source, as stored by the ledger. */
export type WorkSource = "reactions" | "jira" | "pr" | "notion";

/**
 * What a session came from, short enough for a chip in the history row.
 *
 * Only two sources hand out an id a human reads: Jira's key and a PR url. A
 * Slack `channel:ts` and a Notion page uuid say nothing, so those show the
 * source alone rather than a wall of hex.
 */
export function provenanceLabel(
	source: WorkSource,
	externalId: string,
): string {
	switch (source) {
		case "jira":
			return externalId;
		case "pr": {
			const pull = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(externalId);
			return pull ? `${pull[1]}#${pull[2]}` : "Pull request";
		}
		case "reactions":
			return "Slack";
		case "notion":
			return "Notion";
	}
}
