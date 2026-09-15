import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { isInternalBuild } from "main/lib/build-channel";
import { githubAccessToken, githubApiFetch } from "main/lib/github-token";
import { hasJiraOAuth, jiraRequestContext } from "main/lib/jira-token";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { readOdinConfig, resolveGithubToken } from "../odin-config";

/**
 * Odin fork: read-only "my work" feeds — Jira issues assigned to me and GitHub
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

function githubToken(): string | null {
	return resolveGithubToken();
}

/**
 * A feed request that failed. A dead credential is the common case — GitHub
 * OAuth tokens get revoked, Jira tokens expire — so it gets UNAUTHORIZED and
 * the fix, which the panes turn into a "Reconnect" button, instead of dumping
 * the raw API body in the pane. GitHub also spends 403 on rate limits, so that
 * one only counts as auth when the body doesn't say otherwise.
 */
export function feedError(
	provider: string,
	status: number,
	body: string,
): TRPCError {
	const isAuth =
		status === 401 || (status === 403 && !/rate limit/i.test(body));
	return new TRPCError({
		code: isAuth ? "UNAUTHORIZED" : "BAD_REQUEST",
		message: isAuth
			? `${provider} rejected the credentials (${status}) — reconnect ${provider} in Settings → Connections.`
			: `${provider} search failed (${status}): ${body.slice(0, 300)}`,
	});
}

/** The comment that @-mentioned me, flattened for a one-line preview. */
export interface JiraMention {
	author: string | null;
	at: string | null;
	text: string;
}

export interface JiraIssueRow {
	key: string;
	url: string;
	title: string;
	status: string;
	statusCategory: string;
	priority: string | null;
	project: string;
	issueType: string | null;
	reporter: string | null;
	updated: string | null;
	/** Why it's in my list: assigned to me, filed by me, or a comment @s me. */
	role: "assigned" | "reported" | "mentioned";
	/** What was said to me, on the rows that are here because of a mention. */
	mention: JiraMention | null;
}

interface JiraComment {
	author?: { displayName?: string };
	created?: string;
	body?: unknown;
}

/**
 * A comment body is ADF, not text. Flattened to one line for the feed: text
 * nodes as themselves, a mention as the "@Name" Jira already stored on it,
 * breaks as spaces.
 */
export function adfToText(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	const adf = node as {
		type?: string;
		text?: string;
		attrs?: { text?: string };
		content?: unknown[];
	};
	if (adf.type === "mention") return adf.attrs?.text ?? "";
	if (adf.type === "text") return adf.text ?? "";
	const inner = (adf.content ?? []).map(adfToText).join("");
	return adf.type === "paragraph" || adf.type === "hardBreak"
		? `${inner} `
		: inner;
}

/**
 * The last thing someone said to me on a ticket — newest first, because that
 * is the one waiting on an answer. A mention stores my account id in the body,
 * so containing it anywhere is the whole test.
 *
 * ponytail: reads the comments the search already returned, which is the most
 * recent 20. A mention older than that on a busier ticket shows no preview;
 * fetch /issue/{key}/comment per row if that starts mattering.
 */
export function latestMention(
	comments: JiraComment[],
	accountId: string,
): JiraMention | null {
	for (const comment of [...comments].reverse()) {
		if (!JSON.stringify(comment.body ?? null).includes(accountId)) continue;
		return {
			author: comment.author?.displayName ?? null,
			at: comment.created ?? null,
			text: adfToText(comment.body).replace(/\s+/g, " ").trim().slice(0, 1000),
		};
	}
	return null;
}

export interface PullRequestRow {
	id: number;
	number: number;
	url: string;
	title: string;
	repo: string;
	author: string;
	/** "mine" = I opened it; "review" = my review was requested; "mentioned" =
	 * someone @-named me on it (issues as well as PRs). */
	kind: "mine" | "review" | "mentioned";
	draft: boolean;
	updated: string | null;
	comments: number;
}

interface JiraSearchResponse {
	issues?: {
		key: string;
		fields?: {
			summary?: string;
			status?: { name?: string; statusCategory?: { name?: string } };
			priority?: { name?: string };
			project?: { key?: string; name?: string };
			issuetype?: { name?: string };
			reporter?: { displayName?: string };
			updated?: string;
			comment?: { comments?: JiraComment[] };
		};
	}[];
}

interface GithubSearchResponse {
	items?: {
		id: number;
		number: number;
		title: string;
		html_url: string;
		draft?: boolean;
		updated_at?: string;
		comments?: number;
		user?: { login?: string };
		repository_url?: string;
	}[];
}

export const createWorkRouter = () => {
	return router({
		/** Which feeds are usable — lets the views explain a missing token. */
		getConfig: publicProcedure.query(() => ({
			hasJira: hasJiraOAuth(),
			hasGithub: githubToken() !== null,
			/**
			 * Odin's own checkout: gates self-update, and is where "Work on Odin"
			 * sessions launch so the agent starts in the right repo instead of
			 * hunting for it.
			 */
			odinRepoPath: odinRepo(),
			/** Already running from source with hot reload? */
			isDev: process.env.NODE_ENV === "development",
			/** Canary or unpackaged run — gates the self-development toolbar. */
			isInternalBuild: isInternalBuild(),
		})),

		/**
		 * Switch this app into hot-reload mode: run Odin from its checkout so
		 * renderer edits apply instantly. Detached again — the script quits this
		 * app before starting the dev one (both use ~/.odin, and Electron's
		 * single-instance lock allows only one).
		 */
		startDevMode: publicProcedure.mutation(async () => {
			const repo = odinRepo();
			if (!repo) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						'No Odin checkout configured — set ODIN_REPO_DIR or "odinRepo" in ~/.config/odin.json',
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
		 * Rebuild Odin from its checkout and reinstall it — so Odin can be
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
							'No Odin checkout configured — set ODIN_REPO_DIR or "odinRepo" in ~/.config/odin.json',
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
		 * where a comment @-mentions me — being asked a question on someone
		 * else's ticket is work too.
		 *
		 * Separate searches, not one OR'd query: the endpoint caps a result set
		 * at 100, and the combined set is larger than that — sorted by recency,
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
							"Jira isn't connected — sign in from Settings → Connections.",
					});
				}
				const openOnly = input.includeDone ? "" : " AND statusCategory != Done";
				const headers = {
					Authorization: request.authorization,
					Accept: "application/json",
				};
				// Who currentUser() resolved to, so the mention rows can point at
				// the comment that named me. Started here rather than awaited, so
				// it rides alongside the searches instead of delaying them.
				const myAccountId = fetch(`${request.base}/rest/api/3/myself`, {
					headers,
				})
					.then(async (response) =>
						response.ok
							? ((await response.json()) as { accountId?: string }).accountId
							: null,
					)
					.catch(() => null);

				const search = async (
					role: JiraIssueRow["role"],
					match: string,
				): Promise<JiraIssueRow[]> => {
					const jql = `${match}${openOnly} ORDER BY updated DESC`;
					// Comment bodies are only worth their weight on the mention rows,
					// where they are the point.
					const fields = `summary,status,priority,project,issuetype,reporter,assignee,updated${role === "mentioned" ? ",comment" : ""}`;
					const response = await fetch(
						`${request.base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${fields}`,
						{ headers },
					);
					if (!response.ok) {
						throw feedError("Jira", response.status, await response.text());
					}
					const payload = (await response.json()) as JiraSearchResponse;
					const accountId = role === "mentioned" ? await myAccountId : null;
					const rows = (payload.issues ?? []).map((issue) => ({
						key: issue.key,
						url: `${request.siteUrl}/browse/${issue.key}`,
						title: issue.fields?.summary ?? "(no summary)",
						status: issue.fields?.status?.name ?? "Unknown",
						statusCategory:
							issue.fields?.status?.statusCategory?.name ?? "Unknown",
						priority: issue.fields?.priority?.name ?? null,
						project:
							issue.fields?.project?.name ??
							issue.fields?.project?.key ??
							issue.key.split("-")[0],
						issueType: issue.fields?.issuetype?.name ?? null,
						reporter: issue.fields?.reporter?.displayName ?? null,
						updated: issue.fields?.updated ?? null,
						role,
						mention: accountId
							? latestMention(issue.fields?.comment?.comments ?? [], accountId)
							: null,
					}));
					// Jira indexes a comment's author along with its body, so
					// `comment ~ currentUser()` also returns tickets I merely
					// commented on. Only the ones that actually name me belong here.
					return role === "mentioned"
						? rows.filter((row) => row.mention)
						: rows;
				};

				const [assigned, reported, mentioned] = await Promise.all([
					search("assigned", "assignee = currentUser()"),
					search("reported", "reporter = currentUser()"),
					// An @-mention embeds my account id in the comment body, and
					// currentUser() resolves to that id — so a text match on
					// `comment` is what finds "someone tagged me here".
					search("mentioned", "comment ~ currentUser()"),
				]);
				// An issue can come back from several searches; the first claim
				// wins, strongest first — assigned, then filed, then mentioned.
				const seen = new Set<string>();
				const issues: JiraIssueRow[] = [];
				for (const issue of [...assigned, ...reported, ...mentioned]) {
					if (seen.has(issue.key)) continue;
					seen.add(issue.key);
					issues.push(issue);
				}
				return { issues };
			}),

		/**
		 * Open PRs I authored + PRs waiting on my review + issues and PRs where
		 * someone @-mentioned me — being asked a question on someone else's
		 * thread is work too, same as the Jira mention rows.
		 */
		myPullRequests: publicProcedure.query(
			async (): Promise<{ pulls: PullRequestRow[] }> => {
				const token = await githubAccessToken();
				if (!token) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"GitHub isn't connected — sign in from Settings → Connections.",
					});
				}
				const headers = {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				};
				const search = async (
					q: string,
					kind: PullRequestRow["kind"],
				): Promise<PullRequestRow[]> => {
					const response = await githubApiFetch(
						`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=50&sort=updated`,
						{ headers },
						token,
					);
					if (!response.ok) {
						throw feedError("GitHub", response.status, await response.text());
					}
					const payload = (await response.json()) as GithubSearchResponse;
					return (payload.items ?? []).map((item) => ({
						id: item.id,
						number: item.number,
						url: item.html_url,
						title: item.title,
						// repository_url looks like https://api.github.com/repos/<owner>/<repo>
						repo: (item.repository_url ?? "").split("/repos/")[1] ?? "",
						author: item.user?.login ?? "",
						kind,
						draft: item.draft ?? false,
						updated: item.updated_at ?? null,
						comments: item.comments ?? 0,
					}));
				};
				const [mine, review, mentioned] = await Promise.all([
					search("is:open is:pr author:@me archived:false", "mine"),
					search("is:open is:pr review-requested:@me archived:false", "review"),
					// No `is:pr`: a mention on an issue is the same ask as one on a
					// PR, and dropping it would leave the tab half-empty.
					search("is:open mentions:@me archived:false", "mentioned"),
				]);
				// A thread can match several searches; the first claim wins,
				// strongest first — mine, then my review, then merely named.
				const seen = new Set<number>();
				const pulls: PullRequestRow[] = [];
				for (const pull of [...mine, ...review, ...mentioned]) {
					if (seen.has(pull.id)) continue;
					seen.add(pull.id);
					pulls.push(pull);
				}
				return { pulls };
			},
		),
	});
};
