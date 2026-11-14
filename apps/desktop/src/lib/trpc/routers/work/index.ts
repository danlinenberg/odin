import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { isInternalBuild } from "main/lib/build-channel";
import {
	fetchCalendar,
	fetchGoogleMeetings,
	type MeetingRow,
	parseMeetings,
} from "main/lib/calendar";
import { calendarAccessToken, hasCalendarOAuth } from "main/lib/calendar-token";
import {
	adfToText,
	type ClickupTaskRow,
	clickupDate,
	clickupTasks,
	feedError,
	type GithubSearchResponse,
	type JiraIssueRow,
	type JiraSearchResponse,
	jiraIssues,
	type PullRequestRow,
	pullRequests,
} from "main/lib/feeds";
import { githubAccessToken, githubApiFetch } from "main/lib/github-token";
import { hasJiraOAuth, jiraRequestContext } from "main/lib/jira-token";
import { clickupFetch } from "main/lib/read-link";
import { z } from "zod";

export {
	adfToText,
	type ClickupTaskRow,
	currentSprint,
	epicOf,
	feedError,
	type JiraIssueRow,
	type JiraMention,
	latestMention,
	type PullRequestRow,
} from "main/lib/feeds";

import { publicProcedure, router } from "../..";
import { readOdinConfig, resolveGithubToken } from "../odin-config";
import {
	slackInlineAfter,
	slackThreadReplies,
	slackWatchedThread,
} from "../slack";
import { approvedBy, pullRequestState } from "../terminal/pr-state";
import { closeClickupTask } from "./clickup-close";
import {
	CLOSED_UPSTREAM_DAYS,
	type ClosedUpstreamRow,
	clickupClosedPath,
	githubClosedQueries,
	jiraClosedJql,
	mergeClosed,
	sinceDate,
} from "./closed-upstream";
import { type JiraIssueLinksPayload, jiraIssueLinks } from "./jira-links";

/**
 * Odin fork: read-only "my work" feeds - Jira issues assigned to me and GitHub
 * pull requests I wrote or was asked to review.
 *
 * Runs in the main process: renderer fetches to Jira/GitHub would be blocked by
 * CORS, and the tokens never reach the renderer. Both credentials are OAuth
 * tokens from Settings → Connections, stored in ~/.config/odin.json.
 */

/** The Odin checkout to rebuild from. */

function odinRepo(): string | null {
	const repo = process.env.ODIN_REPO_DIR ?? readOdinConfig().odinRepo;
	return repo && existsSync(repo) ? repo : null;
}

const execFileAsync = promisify(execFile);

/**
 * The branch this dev build runs from, so several "Odin Dev" windows can be
 * told apart. A detached checkout (the try-<PR#> previews) has no branch, so
 * it shows the worktree folder and the commit instead.
 */
async function devBranch(): Promise<string | null> {
	const git = (...args: string[]) =>
		execFileAsync("git", args, { cwd: process.cwd() }).then(({ stdout }) =>
			stdout.trim(),
		);
	try {
		const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
		if (branch !== "HEAD") return branch;
		const [topLevel, sha] = await Promise.all([
			git("rev-parse", "--show-toplevel"),
			git("rev-parse", "--short", "HEAD"),
		]);
		return `${basename(topLevel)} @ ${sha}`;
	} catch {
		return null;
	}
}

function githubToken(): string | null {
	return resolveGithubToken();
}

/** One unread inbox email, from Gmail's Atom feed. */
export interface EmailRow {
	id: string;
	url: string;
	subject: string;
	snippet: string;
	from: string | null;
	/** The sender's address - what tells a person from a mailer. */
	fromEmail: string | null;
	at: string | null;
	/** The model's verdict (calendar mail always junk); null = it couldn't say. */
	junk?: boolean | null;
}

export interface GmailCredentials {
	address: string;
	password: string;
}

export function gmailCredentials(): GmailCredentials | null {
	const { gmailAddress, gmailAppPassword } = readOdinConfig();
	return gmailAddress && gmailAppPassword
		? { address: gmailAddress, password: gmailAppPassword }
		: null;
}

/** One GET of the Atom feed - the feed, the Connections probe and the save's check. */
export function fetchGmailFeed(
	credentials: GmailCredentials,
): Promise<Response> {
	const { address, password } = credentials;
	return fetch("https://mail.google.com/mail/feed/atom", {
		headers: {
			// Google shows the app password in groups of four; the spaces aren't part of it.
			Authorization: `Basic ${Buffer.from(`${address}:${password.replace(/\s/g, "")}`).toString("base64")}`,
		},
	});
}

const unescapeXml = (text: string) =>
	text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&amp;/g, "&");

/**
 * The feed links each message as mail?account_id=...&message_id=...&view=conv,
 * a form Gmail no longer opens: it loads an empty "Gmail" page and never shows
 * the thread. This is the same message at the URL Gmail uses itself, in the
 * feed's account rather than whichever one the browser has first.
 */
export function gmailThreadUrl(link: string): string {
	try {
		const url = new URL(link);
		const account = url.searchParams.get("account_id");
		const message = url.searchParams.get("message_id");
		if (url.hostname !== "mail.google.com" || !account || !message) return link;
		return `https://mail.google.com/mail/u/${account}/#all/${message}`;
	} catch {
		return link;
	}
}

/**
 * Gmail's Atom feed → rows.
 */
export function parseGmailAtom(xml: string): EmailRow[] {
	return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
		const tag = (name: string) =>
			unescapeXml(
				entry.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "",
			).trim();
		const author = entry.match(/<author>([\s\S]*?)<\/author>/)?.[1] ?? "";
		const fromEmail =
			unescapeXml(author.match(/<email>([\s\S]*?)<\/email>/)?.[1] ?? "") ||
			null;
		return {
			id: tag("id"),
			url: gmailThreadUrl(
				unescapeXml(entry.match(/<link[^>]*href="([^"]*)"/)?.[1] ?? ""),
			),
			subject: tag("title") || "(no subject)",
			snippet: tag("summary"),
			from:
				unescapeXml(author.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? "") ||
				fromEmail,
			fromEmail,
			at: tag("issued") || tag("modified") || null,
		};
	});
}

/** The newest reply on a watched thread, or a watched PR's approval. */
export interface ThreadActivity {
	/**
	 * Slack ts or Jira comment time - changes when someone replies. "" = no
	 * replies yet. A PR: "approved" or "".
	 */
	stamp: string;
	/** That newest reply is mine - nothing to ping about. */
	byMe: boolean;
	/** What it said, for the notification. */
	text: string | null;
	/** The thread itself, for Open when its session is gone. */
	url: string | null;
}

/**
 * Whether a PR is approved, through Odin's own GitHub connection. Null when
 * that account can't see the PR - a second account's repo then goes through
 * `gh`, which tries every account it's signed into.
 */
async function pullRequestApproval(
	url: string,
	token: string,
): Promise<{
	approved: boolean;
	title: string | null;
	open: boolean;
} | null> {
	const [, owner, name, number] =
		/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url) ?? [];
	if (!number) return null;
	const response = await githubApiFetch(
		"https://api.github.com/graphql",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query:
					"query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewDecision title state latestOpinionatedReviews(first:50){nodes{state author{login}}}}}}",
				variables: { o: owner, r: name, n: Number(number) },
			}),
		},
		token,
	).catch(() => null);
	const payload = response?.ok
		? ((await response.json().catch(() => null)) as {
				data?: {
					repository?: {
						pullRequest?: {
							reviewDecision?: string | null;
							title?: string;
							state?: string;
							latestOpinionatedReviews?: {
								nodes?: {
									state?: string;
									author?: { login?: string } | null;
								}[];
							} | null;
						};
					} | null;
				};
			} | null)
		: null;
	const pr = payload?.data?.repository?.pullRequest;
	if (pr)
		return {
			approved: approvedBy(
				pr.reviewDecision,
				(pr.latestOpinionatedReviews?.nodes ?? []).map((r) => ({
					login: r.author?.login,
					state: r.state,
				})),
			),
			title: pr.title ?? null,
			open: pr.state === "OPEN",
		};
	// GraphQL's hourly quota is shared by every tool on the account; REST has its own.
	return restPullRequestApproval(owner, name, number, token);
}

/**
 * The same answer from REST: the PR, then its reviews. Approved when someone's
 * latest review approves and nobody's latest asks for changes - GraphQL's
 * reviewDecision also weighs required reviewers and code owners, which REST
 * doesn't expose in one call.
 */
async function restPullRequestApproval(
	owner: string,
	name: string,
	number: string,
	token: string,
): Promise<{ approved: boolean; title: string | null; open: boolean } | null> {
	const base = `https://api.github.com/repos/${owner}/${name}/pulls/${number}`;
	const read = async <T>(url: string): Promise<T | null> => {
		const response = await githubApiFetch(url, {}, token).catch(() => null);
		return response?.ok
			? ((await response.json().catch(() => null)) as T | null)
			: null;
	};
	const pull = await read<{ title?: string; state?: string }>(base);
	if (!pull) return null;
	const reviews =
		(await read<{ user?: { login?: string } | null; state?: string }[]>(
			`${base}/reviews?per_page=100`,
		)) ?? [];
	return {
		approved: reviewsApprove(reviews),
		title: pull.title ?? null,
		open: pull.state === "open",
	};
}

/** Each reviewer's latest approve or request-changes counts; comments don't change it. */
export function reviewsApprove(
	reviews: { user?: { login?: string } | null; state?: string }[],
): boolean {
	return approvedBy(
		null,
		reviews.map((r) => ({ login: r.user?.login, state: r.state })),
	);
}

/** Watched PRs that merged or closed: no approval left to wait for, so no more calls. */
const settledPullRequests = new Set<string>();

export const createWorkRouter = () => {
	return router({
		/** Which feeds are usable - lets the views explain a missing token. */
		getConfig: publicProcedure.query(async () => ({
			hasJira: hasJiraOAuth(),
			hasGithub: githubToken() !== null,
			hasGmail: gmailCredentials() !== null,
			hasClickup: !!readOdinConfig().clickupToken,
			hasCalendar: hasCalendarOAuth() || !!readOdinConfig().calendarUrl,
			/**
			 * Odin's own checkout: gates self-update, and is where "Work on Odin"
			 * sessions launch so the agent starts in the right repo instead of
			 * hunting for it.
			 */
			odinRepoPath: odinRepo(),
			/** Already running from source with hot reload? */
			isDev: process.env.NODE_ENV === "development",
			devBranch:
				process.env.NODE_ENV === "development" ? await devBranch() : null,
			/** Canary or unpackaged run - gates the self-development toolbar. */
			isInternalBuild: isInternalBuild(),
		})),

		/**
		 * Switch this app into hot-reload mode: run Odin from its checkout so
		 * renderer edits apply instantly. Detached again - the script quits this
		 * app before starting the dev one (both use ~/.odin, and Electron's
		 * single-instance lock allows only one).
		 */
		startDevMode: publicProcedure.mutation(async () => {
			const repo = odinRepo();
			if (!repo) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						'No Odin checkout configured - set ODIN_REPO_DIR or "odinRepo" in ~/.config/odin.json',
				});
			}
			const script = join(repo, "scripts/odin-dev.sh");
			if (!existsSync(script)) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: `Dev script missing at ${script}`,
				});
			}
			const { spawn } = await import("node:child_process");
			const child = spawn("/bin/bash", [script], {
				cwd: repo,
				detached: true,
				stdio: "ignore",
				// Already in dev? Then this is the "Restart Odin" button, and the
				// script has to quit us first. By pid, not by pattern: every other
				// Electron under this checkout is a live session or the daemon.
				env: {
					...process.env,
					...(process.env.NODE_ENV === "development"
						? { ODIN_QUIT_PID: String(process.pid) }
						: {}),
				},
			});
			child.unref();
			const logPath = join(
				process.env.ODIN_HOME_DIR ?? join(homedir(), ".odin"),
				"dev.log",
			);
			return { started: true, logPath };
		}),

		/** Leave hot-reload mode: stop the dev processes, reopen the packaged app. */
		exitDevMode: publicProcedure.mutation(async () => {
			const repo = odinRepo();
			const { spawn } = await import("node:child_process");
			// Detached: it kills the very processes hosting this call.
			const child = spawn(
				"/bin/bash",
				[
					"-c",
					`sleep 1; pkill -f "${repo ?? "private/odin"}.*electron-vite dev"; pkill -f "${repo ?? "private/odin"}.*turbo run dev"; sleep 2; open -a /Applications/Odin.app`,
				],
				{ detached: true, stdio: "ignore" },
			);
			child.unref();
			return { started: true };
		}),

		/**
		 * Rebuild Odin from its checkout and reinstall it - so Odin can be
		 * changed from inside Odin, without going back to Odin.
		 *
		 * Spawned DETACHED on purpose: the script quits this app partway through
		 * to swap the bundle, which would kill it if it were our child.
		 */
		updateOdin: publicProcedure
			.input(z.object({ pull: z.boolean().optional() }).optional().default({}))
			.mutation(async ({ input }) => {
				const repo = odinRepo();
				if (!repo) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							'No Odin checkout configured - set ODIN_REPO_DIR or "odinRepo" in ~/.config/odin.json',
					});
				}
				const script = join(repo, "scripts/odin-update.sh");
				if (!existsSync(script)) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `Update script missing at ${script}`,
					});
				}
				const { spawn } = await import("node:child_process");
				const logPath = join(
					process.env.ODIN_HOME_DIR ?? join(homedir(), ".odin"),
					"update.log",
				);
				const child = spawn(
					"/bin/bash",
					[script, ...(input.pull ? ["--pull"] : [])],
					{ cwd: repo, detached: true, stdio: "ignore" },
				);
				child.unref();
				return { started: true, logPath };
			}),

		/**
		 * Jira issues I'm on: assigned to me, ones I filed (BUGT triage tickets
		 * are reported by me and assigned to whoever picks them up), and ones
		 * where a comment @-mentions me - being asked a question on someone
		 * else's ticket is work too.
		 *
		 * Separate searches, not one OR'd query: the endpoint caps a result set
		 * at 100, and the combined set is larger than that - sorted by recency,
		 * the assigned issues got truncated away, which is why the project
		 * filter showed almost nothing under "Assigned to me".
		 */
		myJiraIssues: publicProcedure
			.input(
				z
					.object({ includeDone: z.boolean().optional() })
					.optional()
					.default({}),
			)
			.query(async ({ input }): Promise<{ issues: JiraIssueRow[] }> => {
				const request = await jiraRequestContext();
				if (!request) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"Jira isn't connected - sign in from Settings → Connections.",
					});
				}
				const headers = {
					Authorization: request.authorization,
					Accept: "application/json",
				};
				return {
					issues: await jiraIssues(
						(path, init) =>
							fetch(`${request.base}/${path}`, { ...init, headers }),
						request.base,
						request.siteUrl,
						input.includeDone,
					),
				};
			}),

		/**
		 * Status of the Jira tickets a session links, keyed by issue key - the
		 * brief's "open / done" chip. One search for all of them; empty when
		 * Jira isn't connected, so the panel just shows no chip.
		 */
		/**
		 * The links on a ticket - its description, people's comments and remote
		 * links - for the brief of a session launched on it. Empty when Jira
		 * isn't connected or the ticket can't be read.
		 */
		jiraIssueLinks: publicProcedure
			.input(z.object({ key: z.string() }))
			.query(async ({ input }): Promise<string[]> => {
				if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(input.key)) return [];
				const request = await jiraRequestContext();
				if (!request) return [];
				const get = async <T>(path: string): Promise<T | null> => {
					const response = await fetch(`${request.base}/rest/api/3/${path}`, {
						headers: {
							Authorization: request.authorization,
							Accept: "application/json",
						},
					}).catch(() => null);
					return response?.ok ? ((await response.json()) as T) : null;
				};
				const [issue, remote] = await Promise.all([
					get<JiraIssueLinksPayload>(
						`issue/${input.key}?fields=description,comment`,
					),
					get<{ object?: { url?: unknown } }[]>(
						`issue/${input.key}/remotelink`,
					),
				]);
				return issue ? jiraIssueLinks(issue, remote ?? [], input.key) : [];
			}),

		jiraIssueStates: publicProcedure
			.input(z.object({ keys: z.array(z.string()) }))
			.query(
				async ({
					input,
				}): Promise<
					Record<string, { status: string; statusCategory: string }>
				> => {
					const keys = input.keys.filter((key) =>
						/^[A-Z][A-Z0-9_]+-\d+$/.test(key),
					);
					const request = await jiraRequestContext();
					if (!request || keys.length === 0) return {};
					const jql = `key in (${keys.join(",")})`;
					const response = await fetch(
						`${request.base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=status`,
						{
							headers: {
								Authorization: request.authorization,
								Accept: "application/json",
							},
						},
					);
					if (!response.ok) return {};
					const payload = (await response.json()) as JiraSearchResponse;
					return Object.fromEntries(
						(payload.issues ?? []).map((issue) => [
							issue.key,
							{
								status: issue.fields?.status?.name ?? "Unknown",
								statusCategory:
									issue.fields?.status?.statusCategory?.name ?? "Unknown",
							},
						]),
					);
				},
			),

		/**
		 * The newest reply on each watched thread, keyed like the task rows
		 * (`slack:<channel>:<ts>`, `jira:<KEY>`) - what "Ping me" compares
		 * against what it saw last time. A watched PR (`pr:<url>`) reports its
		 * approval the same way, so the same check pings once it's approved. A row Slack or Jira won't
		 * answer for is left out, which reads as "nothing new".
		 */
		threadActivity: publicProcedure
			.input(
				z.object({
					slack: z.array(z.string()),
					jira: z.array(z.string()),
					prs: z.array(z.string().url()).default([]),
				}),
			)
			.query(async ({ input }): Promise<Record<string, ThreadActivity>> => {
				const out: Record<string, ThreadActivity> = {};
				for (const id of input.slack) {
					const thread = await slackThreadReplies(id, { fresh: true });
					const inline = await slackInlineAfter(id);
					// In a DM the answer often comes inline rather than in the
					// thread: whichever is newer is the latest word.
					if (inline && Number(inline.ts) > Number(thread?.lastReplyTs ?? 0))
						out[`slack:${id}`] = {
							stamp: inline.ts,
							byMe: inline.byMe,
							text: inline.text,
							url: inline.url,
						};
					else if (thread)
						out[`slack:${id}`] = {
							stamp: thread.lastReplyTs ?? "",
							byMe: thread.lastReplyByMe,
							...(await slackWatchedThread(id, thread.lastReplyText ?? null)),
						};
				}
				const token = input.prs.length ? await githubAccessToken() : null;
				for (const url of input.prs) {
					if (settledPullRequests.has(url)) continue;
					const approval = token && (await pullRequestApproval(url, token));
					const state = approval ? null : await pullRequestState(url);
					const pr = approval || state;
					if (approval ? !approval.open : state && state.state !== "OPEN")
						settledPullRequests.add(url);
					// A merged PR's old approval isn't news.
					if (pr && !settledPullRequests.has(url))
						out[`pr:${url}`] = {
							stamp: pr.approved ? "approved" : "",
							// Only the turn to approved is news; a push that dismisses it isn't.
							byMe: !pr.approved,
							text: pr.title,
							url,
						};
				}
				const keys = input.jira.filter((key) =>
					/^[A-Z][A-Z0-9_]+-\d+$/.test(key),
				);
				const request = keys.length ? await jiraRequestContext() : null;
				if (!request) return out;
				const headers = {
					Authorization: request.authorization,
					Accept: "application/json",
				};
				const [me, search] = await Promise.all([
					fetch(`${request.base}/rest/api/3/myself`, { headers })
						.then(async (r) =>
							r.ok
								? ((await r.json()) as { accountId?: string }).accountId
								: null,
						)
						.catch(() => null),
					fetch(
						`${request.base}/rest/api/3/search/jql?jql=${encodeURIComponent(`key in (${keys.join(",")})`)}&maxResults=100&fields=comment`,
						{ headers },
					)
						.then(async (r) =>
							r.ok ? ((await r.json()) as JiraSearchResponse) : {},
						)
						.catch((): JiraSearchResponse => ({})),
				]);
				for (const issue of search.issues ?? []) {
					const last = issue.fields?.comment?.comments?.at(-1);
					out[`jira:${issue.key}`] = {
						stamp: last?.created ?? "",
						byMe: !!me && last?.author?.accountId === me,
						text: last
							? `${last.author?.displayName ?? "Someone"}: ${adfToText(last.body).replace(/\s+/g, " ").trim().slice(0, 300)}`
							: null,
						url: `${request.base}/browse/${issue.key}`,
					};
				}
				return out;
			}),

		/**
		 * Unread inbox mail. No OAuth: Gmail still takes Basic auth with an app
		 * password on its Atom feed, so this is one fetch.
		 */
		myEmails: publicProcedure.query(
			async (): Promise<{ emails: EmailRow[] }> => {
				const credentials = gmailCredentials();
				if (!credentials) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"Gmail isn't connected - add it in Settings → Connections.",
					});
				}
				const response = await fetchGmailFeed(credentials);
				if (!response.ok) {
					throw feedError("Gmail", response.status, await response.text());
				}
				const emails = parseGmailAtom(await response.text());
				const { triageEmails } = await import("main/lib/email-triage");
				const verdicts = await triageEmails(emails);
				return {
					emails: emails.map((email) => ({
						...email,
						junk: verdicts.get(email.id) ?? null,
					})),
				};
			},
		),

		/** Right-click "Ignore mail like this": its sender is junk from now on, and the model learns from it. */
		ignoreEmail: publicProcedure
			.input(
				z.object({
					from: z.string().nullable(),
					fromEmail: z.string().nullable(),
					subject: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				const { ignoreEmail } = await import("main/lib/email-triage");
				ignoreEmail(input);
			}),

		/**
		 * Done on a ClickUp row: move the task to its list's closed (or done)
		 * status in ClickUp. Odin's Done stands either way; the caller says when
		 * ClickUp wasn't updated.
		 */
		closeClickupTask: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(async ({ input }) => {
				const token = readOdinConfig().clickupToken;
				if (!token) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "ClickUp isn't connected",
					});
				}
				try {
					return await closeClickupTask(input.id, token, clickupFetch);
				} catch (error) {
					throw new TRPCError({
						code: "BAD_GATEWAY",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}),

		/** Open tasks assigned to me, across every ClickUp workspace the token reaches. */
		myClickupTasks: publicProcedure.query(
			async (): Promise<{ tasks: ClickupTaskRow[] }> => {
				const token = readOdinConfig().clickupToken;
				if (!token) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"ClickUp isn't connected - add it in Settings → Connections.",
					});
				}
				return {
					tasks: await clickupTasks((path) => clickupFetch(path, token)),
				};
			},
		),

		/**
		 * Meetings from now to the end of tomorrow: through the Google Calendar
		 * API when signed in to Google, else from the secret iCal address. Your
		 * Gmail address counts as you, so a meeting you declined there stays out.
		 */
		myMeetings: publicProcedure.query(
			async (): Promise<{ meetings: MeetingRow[] }> => {
				const { calendarUrl, gmailAddress } = readOdinConfig();
				const now = new Date();
				const window = {
					from: now.getTime(),
					to: new Date(
						now.getFullYear(),
						now.getMonth(),
						now.getDate() + 2,
					).getTime(),
				};
				const self = gmailAddress ? [gmailAddress] : [];
				if (hasCalendarOAuth()) {
					const token = await calendarAccessToken();
					if (!token) throw feedError("Calendar", 401, "");
					const result = await fetchGoogleMeetings(token, window, self);
					if (!result.ok) {
						throw feedError("Calendar", result.status, result.body);
					}
					return { meetings: result.meetings };
				}
				if (!calendarUrl) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"Your calendar isn't connected - add it in Settings → Connections.",
					});
				}
				const response = await fetchCalendar(calendarUrl);
				if (!response.ok) {
					throw feedError("Calendar", response.status, await response.text());
				}
				return {
					meetings: parseMeetings(await response.text(), window, self),
				};
			},
		),

		/**
		 * Work related to me that closed in Jira, GitHub or ClickUp in the last
		 * two weeks - All's "Show what's Done" lists it beside what was put
		 * away in Odin. Only asked while that list is on. A source that isn't
		 * connected or fails is left out, so one bad token can't blank the list.
		 */
		recentlyClosed: publicProcedure.query(
			async (): Promise<{ rows: ClosedUpstreamRow[] }> => {
				const days = CLOSED_UPSTREAM_DAYS;
				const now = Date.now();
				const jira = async (): Promise<ClosedUpstreamRow[]> => {
					const request = await jiraRequestContext();
					if (!request) return [];
					const response = await fetch(
						`${request.base}/rest/api/3/search/jql?jql=${encodeURIComponent(jiraClosedJql(days))}&maxResults=50&fields=summary,status,statuscategorychangedate,resolutiondate,updated`,
						{
							headers: {
								Authorization: request.authorization,
								Accept: "application/json",
							},
						},
					);
					if (!response.ok) return [];
					const payload = (await response.json()) as JiraSearchResponse;
					return (payload.issues ?? []).map((issue) => {
						const fields = issue.fields ?? {};
						const at =
							(fields.statuscategorychangedate as string | undefined) ??
							(fields.resolutiondate as string | undefined) ??
							fields.updated ??
							new Date(now).toISOString();
						return {
							key: `jira:${issue.key}`,
							source: "Jira",
							title: `${issue.key} ${fields.summary ?? ""}`.trim(),
							url: `${request.siteUrl}/browse/${issue.key}`,
							state: fields.status?.name ?? "Done",
							closedAt: new Date(at).toISOString(),
						};
					});
				};
				const github = async (): Promise<ClosedUpstreamRow[]> => {
					const token = await githubAccessToken();
					if (!token) return [];
					const pages = await Promise.all(
						githubClosedQueries(sinceDate(days, now)).map(async (q) => {
							const response = await githubApiFetch(
								`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=50&sort=updated`,
								{
									headers: {
										Accept: "application/vnd.github+json",
										"X-GitHub-Api-Version": "2022-11-28",
									},
								},
								token,
							);
							if (!response.ok) return [];
							const payload = (await response.json()) as GithubSearchResponse;
							return (payload.items ?? []).map(
								(item): ClosedUpstreamRow => ({
									key: `github:${item.id}`,
									source: "GitHub",
									title: item.title,
									url: item.html_url,
									state: item.pull_request?.merged_at ? "merged" : "closed",
									closedAt:
										item.closed_at ??
										item.updated_at ??
										new Date(now).toISOString(),
								}),
							);
						}),
					);
					return pages.flat();
				};
				const clickup = async (): Promise<ClosedUpstreamRow[]> => {
					const token = readOdinConfig().clickupToken;
					if (!token) return [];
					const get = async <T>(path: string): Promise<T | null> => {
						const response = await clickupFetch(path, token);
						return response.ok ? ((await response.json()) as T) : null;
					};
					const [me, workspaces] = await Promise.all([
						get<{ user: { id: number } }>("user"),
						get<{ teams: { id: string }[] }>("team"),
					]);
					if (!me || !workspaces) return [];
					const since = now - days * 86_400_000;
					const pages = await Promise.all(
						workspaces.teams.map((team) =>
							get<{
								tasks: {
									id: string;
									name: string;
									url: string;
									status?: { status?: string };
									date_done?: string | null;
									date_closed?: string | null;
								}[];
							}>(clickupClosedPath(team.id, me.user.id, since)),
						),
					);
					return pages.flatMap((page) =>
						(page?.tasks ?? []).flatMap((task) => {
							const at = clickupDate(task.date_done ?? task.date_closed);
							if (!at || Date.parse(at) < since) return [];
							return [
								{
									key: `clickup:${task.id}`,
									source: "ClickUp" as const,
									title: task.name,
									url: task.url,
									state: task.status?.status ?? "closed",
									closedAt: at,
								},
							];
						}),
					);
				};
				const settled = await Promise.allSettled([jira(), github(), clickup()]);
				return {
					rows: mergeClosed(
						settled.flatMap((result) =>
							result.status === "fulfilled" ? result.value : [],
						),
					),
				};
			},
		),

		/**
		 * Open PRs I authored + PRs waiting on my review + issues and PRs where
		 * someone @-mentioned me - being asked a question on someone else's
		 * thread is work too, same as the Jira mention rows.
		 */
		myPullRequests: publicProcedure.query(
			async (): Promise<{ pulls: PullRequestRow[] }> => {
				const token = await githubAccessToken();
				if (!token) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"GitHub isn't connected - sign in from Settings → Connections.",
					});
				}
				const headers = {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				};
				return {
					pulls: await pullRequests((path, init) =>
						githubApiFetch(
							`https://api.github.com/${path}`,
							{ ...init, headers },
							token,
						),
					),
				};
			},
		),
	});
};
