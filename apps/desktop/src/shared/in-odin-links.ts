/**
 * The web hosts of each provider in Settings → Connections - the sites Odin's
 * tasks come from. Only their links can open in the in-app browser, each one
 * unless you send that site to your own browser; anything else always goes
 * there. Settings types this against the provider list, so a new provider
 * can't ship without its entry (an empty list keeps its links out of Odin).
 */
export const LINK_HOSTS = {
	slack: ["slack.com"],
	jira: ["atlassian.net"],
	github: ["github.com"],
	notion: ["notion.so", "notion.site", "notion.com"],
	gmail: ["mail.google.com"],
	clickup: ["clickup.com"],
} as const satisfies Record<string, readonly string[]>;

export type LinkSiteId = keyof typeof LINK_HOSTS;

/** The site a web link is on (or on a subdomain of), if it's one of those. */
export function linkSite(url: string): LinkSiteId | null {
	if (!/^https?:\/\//i.test(url)) return null;
	try {
		const { hostname } = new URL(url);
		const site = (Object.keys(LINK_HOSTS) as LinkSiteId[]).find((id) =>
			LINK_HOSTS[id].some(
				(host) => hostname === host || hostname.endsWith(`.${host}`),
			),
		);
		return site ?? null;
	} catch {
		return null;
	}
}

export function opensInOdin(url: string): boolean {
	return linkSite(url) !== null;
}
