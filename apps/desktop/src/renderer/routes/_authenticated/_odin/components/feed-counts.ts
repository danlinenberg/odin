import {
	HiOutlineClipboardDocumentCheck,
	HiOutlineDocumentText,
	HiOutlineInbox,
} from "react-icons/hi2";
import { LuGitPullRequest } from "react-icons/lu";
import { SiClickup, SiGmail, SiJira, SiNotion, SiSlack } from "react-icons/si";
import type { Provider } from "renderer/components/ConnectProvider/ConnectProvider";

/**
 * The task feeds, in tab order. One rail entry opens them; the strip in each
 * view's header switches between them - they're all "things to do", so they
 * read as one place with sources rather than an icon each.
 */
export const FEED_TABS = [
	{ to: "/all", label: "All", Icon: HiOutlineInbox },
	{ to: "/my-tasks", label: "Tasks", Icon: HiOutlineClipboardDocumentCheck },
	{ to: "/docs", label: "Docs", Icon: HiOutlineDocumentText },
	{ to: "/reactions", label: "Slack", Icon: SiSlack, provider: "slack" },
	{ to: "/jira", label: "Jira", Icon: SiJira, provider: "jira" },
	{ to: "/prs", label: "GitHub", Icon: LuGitPullRequest, provider: "github" },
	{ to: "/notion", label: "Notion", Icon: SiNotion, provider: "notion" },
	{ to: "/email", label: "Email", Icon: SiGmail, provider: "gmail" },
	{ to: "/clickup", label: "ClickUp", Icon: SiClickup, provider: "clickup" },
] as const satisfies readonly {
	to: string;
	label: string;
	Icon: unknown;
	provider?: Provider;
}[];

export type FeedPath = (typeof FEED_TABS)[number]["to"];

/** Every Settings → Connections provider has its tab here: a new one fails the build until it gets one. */
type ProviderWithoutTab = Exclude<
	Provider,
	Extract<(typeof FEED_TABS)[number], { provider: string }>["provider"]
>;
export const EVERY_PROVIDER_HAS_A_TAB: [ProviderWithoutTab] extends [never]
	? true
	: ProviderWithoutTab = true;

/** Renovate/dependabot/CI accounts - noise in a review queue. */
export const isBot = (author: string) =>
	/\[bot\]$|^(renovate|dependabot)/i.test(author);

/**
 * The badge on each tab: what's actually waiting on you, not how many rows the
 * feed holds. Slack counts only un-started messages, and PRs drop the bots the
 * PR view itself hides by default - otherwise a renovate spree reads as work.
 */
export function feedCounts(input: {
	tasks: number;
	slack: { status: string }[];
	jira: unknown[];
	pulls: { author: string; kind?: string }[];
	notion: unknown[];
	emails?: unknown[];
	clickup?: unknown[];
	docs?: number;
}): Record<FeedPath, number> {
	const sources = {
		"/my-tasks": input.tasks,
		"/reactions": input.slack.filter((row) => row.status === "Not started")
			.length,
		"/jira": input.jira.length,
		"/prs": input.pulls.filter((pull) => !isBot(pull.author)).length,
		"/notion": input.notion.length,
		"/email": input.emails?.length ?? 0,
		"/clickup": input.clickup?.length ?? 0,
	};
	// All is the sum of the others, not a count of its own - otherwise the strip
	// would be disagreeing with itself. Less your own PRs, which All leaves out.
	const mine = input.pulls.filter(
		(pull) => pull.kind === "mine" && !isBot(pull.author),
	).length;
	return {
		...sources,
		"/all": Object.values(sources).reduce((total, n) => total + n, 0) - mine,
		// Shown on its tab, but kept out of All: a doc is reading, not work.
		"/docs": input.docs ?? 0,
	};
}

/** Why a source tab is marked: never signed in, or signed in and failing. */
export type FeedIssue = "off" | "error";

/**
 * Which source tabs to mark, and why. A present token is not a working one -
 * a revoked GitHub token leaves the feed erroring with a full account behind
 * it, and an empty tab with no mark reads as "nothing to do" either way.
 *
 * Only a definite no counts for "off": while a config query is still loading
 * the answer is `undefined`, and a dot that flashes on every launch is worse
 * than one that arrives a moment late. All and Tasks are local, so they're
 * never passed in.
 */
export function feedIssues(
	sources: Partial<Record<FeedPath, { connected?: boolean; failed?: boolean }>>,
): Partial<Record<FeedPath, FeedIssue>> {
	const marks: Partial<Record<FeedPath, FeedIssue>> = {};
	for (const [path, source] of Object.entries(sources)) {
		const issue: FeedIssue | undefined =
			source.connected === false ? "off" : source.failed ? "error" : undefined;
		if (issue) marks[path as FeedPath] = issue;
	}
	return marks;
}
