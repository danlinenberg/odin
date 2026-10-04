/**
 * The sites Odin's tasks come from — Slack, Jira, GitHub, Notion and Gmail,
 * the providers in Settings → Connections — plus Google Docs, where their
 * specs live. Only their links open in the in-app browser; anything else goes
 * to your own browser.
 */
const TASK_SOURCE_HOSTS = [
	"slack.com",
	"atlassian.net",
	"github.com",
	"notion.so",
	"notion.site",
	"mail.google.com",
	"docs.google.com",
];

/** Whether a link is a web page on one of those sites, or a subdomain of one. */
export function opensInOdin(url: string): boolean {
	if (!/^https?:\/\//i.test(url)) return false;
	try {
		const { hostname } = new URL(url);
		return TASK_SOURCE_HOSTS.some(
			(host) => hostname === host || hostname.endsWith(`.${host}`),
		);
	} catch {
		return false;
	}
}
