/**
 * The links a Jira ticket carries - in its description, in comments people
 * wrote, and in its remote links - so a session launched on the ticket lists
 * its PRs, threads and pages in the brief whoever wrote them. Comments by app
 * accounts (an automation's boilerplate) are skipped: they say the same thing
 * on every ticket.
 */

const URL_IN_TEXT = /https?:\/\/[^\s<>"'\])]+/g;

interface AdfNode {
	type?: string;
	text?: string;
	attrs?: { url?: unknown; href?: unknown };
	marks?: { attrs?: { href?: unknown } }[];
	content?: AdfNode[];
}

export interface JiraIssueLinksPayload {
	fields?: {
		description?: AdfNode | null;
		comment?: {
			comments?: { author?: { accountType?: string }; body?: AdfNode }[];
		};
	};
}

function adfUrls(node: AdfNode | null | undefined, out: string[]): void {
	if (!node) return;
	for (const value of [node.attrs?.url, node.attrs?.href])
		if (typeof value === "string") out.push(value);
	for (const mark of node.marks ?? [])
		if (typeof mark.attrs?.href === "string") out.push(mark.attrs.href);
	if (node.text) out.push(...(node.text.match(URL_IN_TEXT) ?? []));
	for (const child of node.content ?? []) adfUrls(child, out);
}

/** Every http(s) link on the ticket, once each, in the order it appears. */
export function jiraIssueLinks(
	issue: JiraIssueLinksPayload,
	remote: { object?: { url?: unknown } }[] = [],
	self?: string,
): string[] {
	const found: string[] = [];
	adfUrls(issue.fields?.description, found);
	for (const comment of issue.fields?.comment?.comments ?? [])
		if (comment.author?.accountType !== "app") adfUrls(comment.body, found);
	for (const link of remote)
		if (typeof link.object?.url === "string") found.push(link.object.url);
	const urls = found
		.map((url) => url.replace(/[).,;:]+$/, ""))
		.filter((url) => /^https?:\/\//.test(url))
		.filter((url) => !self || !url.includes(`/browse/${self}`));
	return [...new Set(urls)];
}
