import { githubApiFetch } from "main/lib/github-token";
import { jiraRequestContext } from "main/lib/jira-token";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { readOdinConfig, resolveGithubToken } from "../odin-config";
import { slackConversation, slackThreadReplies } from "../slack";
import {
	approverOf,
	duplicates,
	type JiraActivity,
	type JiraOwnership,
	jiraMovedAt,
	jiraOwnership,
	mapLimit,
	type Reference,
	type Review,
	type SweepDeps,
	type SweepItem,
	slackRef,
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
	status: z.string().optional(),
	sender: z.string().optional(),
});

/** The lookups, wired to the credentials — resolved once for a whole sweep. */
async function lookups(): Promise<SweepDeps> {
	const jira = await jiraRequestContext();
	const github = resolveGithubToken();
	const me = readOdinConfig().githubLogin?.toLowerCase();
	// Who I am to Jira, once per sweep: whose ticket it is turns on it.
	const myAccountId = jira
		? await fetch(`${jira.base}/rest/api/3/myself`, {
				headers: {
					Authorization: jira.authorization,
					Accept: "application/json",
				},
			})
				.then(async (res) =>
					res.ok
						? (((await res.json()) as { accountId?: string }).accountId ?? null)
						: null,
				)
				.catch(() => null)
		: null;
	return {
		jiraStatus: async (key) => {
			if (!jira) return null;
			try {
				const res = await fetch(
					`${jira.base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,created,comment,assignee&expand=changelog`,
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
				const issue = (await res.json()) as JiraActivity &
					JiraOwnership & {
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
					movedAt: jiraMovedAt(issue),
					...jiraOwnership(issue, myAccountId),
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
					mergeable_state?: string;
					requested_reviewers?: { login?: string }[];
					requested_teams?: { slug?: string }[];
				};
				const author = body.user?.login?.toLowerCase();
				// Only a PR someone else wrote is a review request; my own
				// approved PR still wants merging. Without my login there's no
				// telling the two apart, so don't ask.
				const theirs =
					!ref.issue && me && author && author !== me && body.state === "open";
				const reviews = theirs ? await reviewsOf(ref, github) : null;
				const iReviewed = (reviews ?? []).some(
					(review) => review.user?.login?.toLowerCase() === me,
				);
				const askedOfMe = (body.requested_reviewers ?? []).some(
					(user) => user.login?.toLowerCase() === me,
				);
				const team = body.requested_teams?.[0]?.slug ?? null;
				return {
					approvedBy: reviews && me ? approverOf(reviews, me) : null,
					teamOnly:
						theirs && reviews && team && !askedOfMe && !iReviewed ? team : null,
					conflictedForDays:
						theirs && body.mergeable_state === "dirty"
							? await daysSinceLastCommit(ref, github)
							: null,
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
 * A PR's reviews, or null when GitHub won't say.
 *
 * ponytail: first 100 reviews only; page if a PR ever collects more.
 */
async function reviewsOf(
	ref: Extract<Reference, { kind: "github" }>,
	token: string,
): Promise<Review[] | null> {
	try {
		const res = await githubApiFetch(
			`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`,
			{ headers: { Accept: "application/vnd.github+json" } },
			token,
		);
		return res.ok ? ((await res.json()) as Review[]) : null;
	} catch {
		return null;
	}
}

/**
 * Days since the PR's newest commit. Null past 100 commits — the list is
 * oldest-first, so the newest would be off the page.
 */
async function daysSinceLastCommit(
	ref: Extract<Reference, { kind: "github" }>,
	token: string,
): Promise<number | null> {
	try {
		const res = await githubApiFetch(
			`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits?per_page=100`,
			{ headers: { Accept: "application/vnd.github+json" } },
			token,
		);
		if (!res.ok) return null;
		const commits = (await res.json()) as {
			commit?: { committer?: { date?: string } };
		}[];
		if (commits.length === 0 || commits.length >= 100) return null;
		const at = Date.parse(commits.at(-1)?.commit?.committer?.date ?? "");
		return Number.isFinite(at)
			? Math.floor((Date.now() - at) / 86_400_000)
			: null;
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
		 * Sixteen rows at a time; Slack's own gate in `slackApi` holds it to
		 * four calls, so a Slack row waiting out a 429 doesn't stall the Jira
		 * and GitHub rows behind it.
		 */
		sweep: publicProcedure
			.input(z.object({ items: z.array(ItemSchema) }))
			.mutation(async ({ input }) => {
				const looked = await lookups();
				// Each Slack row's thread facts, kept for the conversation read below.
				const threads = new Map<
					string,
					NonNullable<Awaited<ReturnType<SweepDeps["slackThread"]>>>
				>();
				const deps: SweepDeps = {
					...looked,
					slackThread: async (id) => {
						const thread = await looked.slackThread(id);
						if (thread) threads.set(id, thread);
						return thread;
					},
				};
				const started = Date.now();
				const copies = duplicates(input.items);
				const rows = await mapLimit(
					input.items,
					16,
					async (item: SweepItem) => ({
						key: item.key,
						...(copies.get(item.key) ?? (await sweepItem(item, deps))),
					}),
				);
				// The rules' KEEPs on a Slack conversation go to a model that reads
				// it. Only KEEPs: the rules' DROPs and UNKNOWNs stand.
				// The rules' KEEPs on a Slack conversation get read by a model —
				// in the background, since Slack only lets the reading go a call a
				// minute. Only KEEPs: the rules' DROPs and UNKNOWNs stand.
				const kept = input.items.flatMap((item, i) => {
					const ref = slackRef(item);
					if (rows[i].verdict !== "KEEP" || !ref) return [];
					const thread = threads.get(ref);
					const stamp = thread
						? `${thread.lastReplyTs}|${thread.isDirect ? thread.channelLastTs : ""}`
						: "?";
					return [{ key: item.key, source: item.source, ref, stamp }];
				});
				const { judgeKept } = await import("main/lib/sweep-judge");
				const { drops, pending } = await judgeKept(kept, slackConversation);
				for (const row of rows) {
					const why = drops.get(row.key);
					if (why !== undefined) {
						row.verdict = "DROP";
						row.evidence = `read the conversation: ${why || "nobody is waiting on you"}`;
					}
				}
				console.warn(
					`[review] ${kept.length} kept conversations: ${drops.size} dropped on a read, ${pending} still being read`,
				);
				console.warn(
					`[review] swept ${rows.length} rows in ${Math.round((Date.now() - started) / 1000)}s, ${rows.filter((row) => row.verdict === "UNKNOWN").length} unknown`,
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
					/** Settings → Backlog: how you want them sorted, in your words. */
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
