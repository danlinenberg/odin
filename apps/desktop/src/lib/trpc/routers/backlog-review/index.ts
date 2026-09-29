import { githubApiFetch } from "main/lib/github-token";
import { jiraRequestContext } from "main/lib/jira-token";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { readOdinConfig, resolveGithubToken } from "../odin-config";
import { slackThreadReplies } from "../slack";
import {
	approverOf,
	type Reference,
	type Review,
	type SweepDeps,
	type SweepItem,
	sweepItem,
} from "./sweep";

/**
 * The Review screen's end of the sweep: ask Jira, GitHub and Slack what they
 * say about each backlog row now, and hand back one verdict per row.
 *
 * This is where the sweep runs, rather than in an agent session started for
 * it. Odin holds the tokens and already talks to all three; a session would
 * have to be handed the backlog, be trusted to go and look it up, and write
 * its answers back through a file. The verdict rules live in `sweep.ts`, with
 * no electron in them, so they can be tested without a token.
 */

const ItemSchema = z.object({
	key: z.string(),
	source: z.string(),
	title: z.string(),
	detail: z.string().optional(),
	url: z.string().optional(),
	unreacted: z.boolean().optional(),
	lastActivityAt: z.number().optional(),
});

/** The lookups, wired to the credentials — resolved once for a whole sweep. */
async function lookups(): Promise<SweepDeps> {
	const jira = await jiraRequestContext();
	const github = resolveGithubToken();
	const me = readOdinConfig().githubLogin?.toLowerCase();
	return {
		jiraStatus: async (key) => {
			if (!jira) return null;
			try {
				const res = await fetch(
					`${jira.base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`,
					{
						headers: {
							Authorization: jira.authorization,
							Accept: "application/json",
						},
					},
				);
				// 404 is an ordinary answer here, not a failure: anything
				// key-shaped gets asked about, "UTF-8" included.
				if (!res.ok) return null;
				const issue = (await res.json()) as {
					fields?: {
						status?: { name?: string; statusCategory?: { key?: string } };
					};
				};
				const status = issue.fields?.status;
				if (!status?.name) return null;
				return {
					name: status.name,
					// statusCategory is Jira's own three-way (new / indeterminate /
					// done) and survives a renamed column, which matching on the
					// status name would not.
					done: status.statusCategory?.key === "done",
				};
			} catch {
				return null;
			}
		},
		githubState: async (ref: Extract<Reference, { kind: "github" }>) => {
			if (!github) return null;
			try {
				const res = await githubApiFetch(
					`https://api.github.com/repos/${ref.owner}/${ref.repo}/${ref.issue ? "issues" : "pulls"}/${ref.number}`,
					{ headers: { Accept: "application/vnd.github+json" } },
					github,
				);
				if (!res.ok) return null;
				const body = (await res.json()) as {
					state?: string;
					merged?: boolean;
					pull_request?: { merged_at?: string | null };
					user?: { login?: string };
				};
				const author = body.user?.login?.toLowerCase();
				// Only a PR someone else wrote is a review request; my own
				// approved PR still wants merging. Without my login there's no
				// telling the two apart, so don't ask.
				const approvedBy =
					!ref.issue && me && author && author !== me && body.state === "open"
						? await approvedByOther(ref, me, github)
						: null;
				return {
					approvedBy,
					state: body.state ?? "open",
					// A /issues/ URL that points at a PR answers from the issues
					// endpoint, where the merge is on a nested object.
					merged: body.merged === true || Boolean(body.pull_request?.merged_at),
				};
			} catch {
				return null;
			}
		},
		slackThread: slackThreadReplies,
	};
}

/**
 * Who, other than me, currently approves this PR.
 *
 * ponytail: first 100 reviews only; page if a PR ever collects more.
 */
async function approvedByOther(
	ref: Extract<Reference, { kind: "github" }>,
	me: string,
	token: string,
): Promise<string | null> {
	try {
		const res = await githubApiFetch(
			`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`,
			{ headers: { Accept: "application/vnd.github+json" } },
			token,
		);
		if (!res.ok) return null;
		const reviews = (await res.json()) as Review[];
		return approverOf(reviews, me);
	} catch {
		return null;
	}
}

export const createBacklogReviewRouter = () => {
	return router({
		/**
		 * Check the whole backlog and answer for every row.
		 *
		 * The items are passed in because that is where the backlog lives —
		 * tasks in renderer storage, the Slack queue behind an IPC call — and
		 * the answers go straight back. Nothing is written anywhere: a DROP is a
		 * suggestion until someone clicks it on the Review screen.
		 *
		 * ponytail: every item in flight at once. A backlog is tens of rows and
		 * most of them cost no call at all; add a concurrency limit if Slack
		 * ever starts answering `ratelimited`.
		 */
		sweep: publicProcedure
			.input(z.object({ items: z.array(ItemSchema) }))
			.mutation(async ({ input }) => {
				const deps = await lookups();
				const rows = await Promise.all(
					input.items.map(async (item: SweepItem) => ({
						key: item.key,
						...(await sweepItem(item, deps)),
					})),
				);
				return { rows };
			}),

		/**
		 * The board's Next in line order: every unstarted feed task, most
		 * important first, as ranked by `claude -p`, plus the keys your
		 * instructions say to leave out. Keys only — the board
		 * already holds the rows. Cached on the exact input in main.
		 */
		rankNextInLine: publicProcedure
			.input(
				z.object({
					items: z.array(
						z.object({
							key: z.string(),
							title: z.string(),
							source: z.string(),
							priority: z.string().nullable(),
							person: z.string().nullable(),
							context: z.string().nullable(),
							due: z.string().nullable(),
							ageDays: z.number().nullable(),
							review: z.string().nullable(),
						}),
					),
					/** Settings → Board: how you want them sorted, in your words. */
					instructions: z.string().max(4000).optional(),
					/** Skip the cache: the Apply button always means a new run. */
					fresh: z.boolean().optional(),
				}),
			)
			.query(async ({ input }) => {
				const { rankTasks } = await import("main/lib/next-in-line-rank");
				return rankTasks(input.items, {
					instructions: input.instructions,
					fresh: input.fresh,
				});
			}),
	});
};
