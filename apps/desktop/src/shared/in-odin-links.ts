/**
 * The sites Odin's tasks come from - the providers in Settings → Connections.
 * Only their links can open in the in-app browser, each one unless you send
 * that site to your own browser; anything else always goes there.
 */
export const LINK_SITES = [
	{ id: "slack", label: "Slack", hosts: ["slack.com"] },
	{ id: "jira", label: "Jira", hosts: ["atlassian.net"] },
	{ id: "github", label: "GitHub", hosts: ["github.com"] },
	{ id: "notion", label: "Notion", hosts: ["notion.so", "notion.site"] },
	{ id: "gmail", label: "Gmail", hosts: ["mail.google.com"] },
] as const;

export type LinkSiteId = (typeof LINK_SITES)[number]["id"];

/** The site a web link is on (or on a subdomain of), if it's one of those. */
export function linkSite(url: string): LinkSiteId | null {
	if (!/^https?:\/\//i.test(url)) return null;
	try {
		const { hostname } = new URL(url);
		const site = LINK_SITES.find(({ hosts }) =>
			hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)),
		);
		return site?.id ?? null;
	} catch {
		return null;
	}
}

export function opensInOdin(url: string): boolean {
	return linkSite(url) !== null;
}
