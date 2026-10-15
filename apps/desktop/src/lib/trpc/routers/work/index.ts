import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { isInternalBuild } from "main/lib/build-channel";
import { githubAccessToken, githubApiFetch } from "main/lib/github-token";
import { hasJiraOAuth, jiraRequestContext } from "main/lib/jira-token";
import { clickupFetch } from "main/lib/read-link";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { readOdinConfig, resolveGithubToken } from "../odin-config";
import { slackThreadReplies, slackWatchedThread } from "../slack";
import { pullRequestState } from "../terminal/pr-state";

/**
 * Odin fork: read-only "my work" feeds - Jira issues assigned to me and GitHub
 * pull requests I wrote or was asked to review.
 *
 * Runs in the main process: renderer fetches to Jira/GitHub would be blocked by
 * CORS, and the tokens never reach the renderer. Both credentials are OAuth
 * tokens from Settings → Connections, stored in ~/.config/odin.json.
 */

/** The Odin checkout to rebuild from. */
/**
 * Whether a Jira project + issue type's screen has a Due date field, by
 * `base|project|issueType`. Screens change rarely; a restart re-asks.
 */
const dueOnScreen = new Map<string, Promise<boolean>>();

/**
 * The Sprint field's id on each Jira site, by base URL. It's a custom field
 * (customfield_10020 on most sites, not all), so it's found by its type once.
 */
const sprintFieldBySite = new Map<string, Promise<string | null>>();

interface JiraSprintValue {
	name?: string;
	state?: string;
	startDate?: string;
	endDate?: string;
}

/**
 * The sprint a ticket sits in the way Jira's backlog shows it: the active
 * one, else the next one coming, else none - an open ticket whose sprints
 * have all closed is back in the Backlog.
 */
export function currentSprint(value: unknown): JiraIssueRow["sprint"] {
	if (!Array.isArray(value)) return null;
	const sprints = (value as JiraSprintValue[]).filter((s) => s?.name);
	const pick =
		sprints.find((s) => s.state === "active") ??
		sprints
			.filter((s) => s.state === "future")
			.sort((a, b) =>
				(a.startDate ?? "~").localeCompare(b.startDate ?? "~"),
			)[0];
	if (!pick?.name) return null;
	return {
		name: pick.name,
		state: pick.state === "active" ? "active" : "future",
		startDate: pick.startDate ?? null,
		endDate: pick.endDate ?? null,
	};
}

function odinRepo(): string | null {
	const repo = process.env.ODIN_REPO_DIR ?? readOdinConfig().odinRepo;
	return repo && existsSync(repo) ? repo : null;
}

function githubToken(): string | null {
	return resolveGithubToken();
}

/**
 * A feed request that failed. A dead credential is the common case - GitHub
 * OAuth tokens get revoked, Jira tokens expire - so it gets UNAUTHORIZED and
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
			? `${provider} rejected the credentials (${status}) - reconnect ${provider} in Settings → Connections.`
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
	/** When the ticket was filed. */
	created?: string | null;
	/** Jira's own Due Date, `YYYY-MM-DD`. Null on the tickets nobody dated. */
	dueDate: string | null;
	/** Why it's in my list: assigned to me, filed by me, or a comment @s me. */
	role: "assigned" | "reported" | "mentioned";
	/** What was said to me, on the rows that are here because of a mention. */
	mention: JiraMention | null;
	/** The ticket's description as plain text, capped - for the hover card. */
	description?: string | null;
	/** The epic it sits under. Null when it has none, or its parent is a story. */
	epic?: { key: string; title: string } | null;
	/** The sprint it's in on Jira's board; null = the Backlog. */
	sprint?: {
		name: string;
		state: "active" | "future";
		startDate: string | null;
		endDate: string | null;
	} | null;
}

interface JiraParent {
	key: string;
	fields?: {
		summary?: string;
		issuetype?: { name?: string; hierarchyLevel?: number };
	};
}

/**
 * The parent, when it's an epic. A sub-task's parent is a story, not an epic;
 * hierarchy level 1 is the epic level whatever the site renamed the type to.
 */
export function epicOf(parent: JiraParent | undefined): JiraIssueRow["epic"] {
	const type = parent?.fields?.issuetype;
	if (
		!parent ||
		!(type?.hierarchyLevel === 1 || /epic/i.test(type?.name ?? ""))
	)
		return null;
	return { key: parent.key, title: parent.fields?.summary ?? parent.key };
}

interface JiraComment {
	author?: { displayName?: string; accountId?: string };
	created?: string;
	body?: unknown;
}

/**
 * A comment body is ADF, not text. Flattened to one line for the feed: text
 * nodes as themselves, a mention as the "@Name" Jira already stored on it,
 * breaks as spaces - or as `br`, when the line breaks are worth keeping.
 */
export function adfToText(node: unknown, br = " "): string {
	if (!node || typeof node !== "object") return "";
	const adf = node as {
		type?: string;
		text?: string;
		attrs?: { text?: string };
		content?: unknown[];
	};
	if (adf.type === "mention") return adf.attrs?.text ?? "";
	if (adf.type === "text") return adf.text ?? "";
	const inner = (adf.content ?? [])
		.map((child) => adfToText(child, br))
		.join("");
	return adf.type === "paragraph" ||
		adf.type === "hardBreak" ||
		(br !== " " && (adf.type === "heading" || adf.type === "listItem"))
		? `${inner}${br}`
		: inner;
}

/**
 * The last thing someone said to me on a ticket - newest first, because that
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
	/** When the PR was opened. */
	created?: string | null;
	comments: number;
	/** The PR or issue body, markdown as written, capped. */
	body?: string | null;
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

/** One open ClickUp task assigned to me. */
export interface ClickupTaskRow {
	id: string;
	url: string;
	name: string;
	status: string | null;
	priority: string | null;
	list: string | null;
	creator: string | null;
	description: string | null;
	updated: string | null;
	created: string | null;
	dueDate: string | null;
}

/** ClickUp dates are epoch-ms strings; the feeds speak ISO. */
const clickupDate = (ms: string | null | undefined) =>
	ms ? new Date(Number(ms)).toISOString() : null;

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
 * Gmail's Atom feed → rows. ponytail: regex, not an XML parser - the feed is
 * a fixed, flat shape Gmail has served unchanged for 15 years. It holds the
 * 20 newest unread inbox threads; that's the ceiling, IMAP is the upgrade.
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
			url: unescapeXml(entry.match(/<link[^>]*href="([^"]*)"/)?.[1] ?? ""),
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
			created?: string;
			duedate?: string;
			comment?: { comments?: JiraComment[] };
			description?: unknown;
			parent?: JiraParent;
			[custom: string]: unknown;
		};
	}[];
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
): Promise<{ approved: boolean; title: string | null } | null> {
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
					"query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewDecision title}}}",
				variables: { o: owner, r: name, n: Number(number) },
			}),
		},
		token,
	).catch(() => null);
	if (!response?.ok) return null;
	const payload = (await response.json().catch(() => null)) as {
		data?: {
			repository?: {
				pullRequest?: { reviewDecision?: string | null; title?: string };
			} | null;
		};
	} | null;
	const pr = payload?.data?.repository?.pullRequest;
	return pr
		? { approved: pr.reviewDecision === "APPROVED", title: pr.title ?? null }
		: null;
}

interface GithubSearchResponse {
	items?: {
		id: number;
		number: number;
		title: string;
		html_url: string;
		draft?: boolean;
		updated_at?: string;
		created_at?: string;
		comments?: number;
		user?: { login?: string };
		repository_url?: string;
		body?: string | null;
	}[];
}

export const createWorkRouter = () => {
	return router({
		/** Which feeds are usable - lets the views explain a missing token. */
		getConfig: publicProcedure.query(() => ({
			hasJira: hasJiraOAuth(),
			hasGithub: githubToken() !== null,
			hasGmail: gmailCredentials() !== null,
			hasClickup: !!readOdinConfig().clickupToken,
			/**
			 * Odin's own checkout: gates self-update, and is where "Work on Odin"
			 * sessions launch so the agent starts in the right repo instead of
			 * hunting for it.
			 */
			odinRepoPath: odinRepo(),
			/** Already running from source with hot reload? */
			isDev: process.env.NODE_ENV === "development",
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

				let sprintFieldRequest = sprintFieldBySite.get(request.base);
				if (!sprintFieldRequest) {
					sprintFieldRequest = fetch(`${request.base}/rest/api/3/field`, {
						headers,
					})
						.then(async (response) => {
							if (!response.ok) return null;
							const fields = (await response.json()) as {
								id: string;
								schema?: { custom?: string };
							}[];
							return (
								fields.find(
									(field) =>
										field.schema?.custom ===
										"com.pyxis.greenhopper.jira:gh-sprint",
								)?.id ?? null
							);
						})
						.catch(() => null);
					sprintFieldBySite.set(request.base, sprintFieldRequest);
				}
				const sprintField = await sprintFieldRequest;

				const search = async (
					role: JiraIssueRow["role"],
					match: string,
				): Promise<JiraIssueRow[]> => {
					const jql = `${match}${openOnly} ORDER BY updated DESC`;
					// Comment bodies are only worth their weight on the mention rows,
					// where they are the point.
					const fields = `summary,status,priority,project,issuetype,reporter,assignee,updated,created,duedate,description,parent${sprintField ? `,${sprintField}` : ""}${role === "mentioned" ? ",comment" : ""}`;
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
						created: issue.fields?.created ?? null,
						dueDate: issue.fields?.duedate ?? null,
						role,
						// ponytail: capped at 3000 chars so a few hundred tickets stay a
						// small payload; the hover only shows that much anyway.
						description:
							adfToText(issue.fields?.description, "\n")
								.replace(/\n{3,}/g, "\n\n")
								.trim()
								.slice(0, 3000) || null,
						epic: epicOf(issue.fields?.parent),
						sprint: sprintField
							? currentSprint(issue.fields?.[sprintField])
							: null,
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
					// currentUser() resolves to that id - so a text match on
					// `comment` is what finds "someone tagged me here".
					search("mentioned", "comment ~ currentUser()"),
				]);
				// An issue can come back from several searches; the first claim
				// wins, strongest first - assigned, then filed, then mentioned. The
				// mention rides along on the winner: it's what brings a ticket I put
				// away with Done back when someone asks me something on it.
				const mentions = new Map(
					mentioned.map((row) => [row.key, row.mention]),
				);
				const seen = new Set<string>();
				const issues: JiraIssueRow[] = [];
				for (const issue of [...assigned, ...reported, ...mentioned]) {
					if (seen.has(issue.key)) continue;
					seen.add(issue.key);
					issues.push({ ...issue, mention: mentions.get(issue.key) ?? null });
				}
				// A due date Jira keeps but doesn't show: an issue type whose
				// screen has no Due date field still returns the stored value (an
				// epic created with one, say). Only a date you can see in Jira
				// counts. The screen is per project and issue type, so one editmeta
				// call per pair; a failed check keeps the date.
				await Promise.all(
					issues
						.filter((issue) => issue.dueDate)
						.map(async (issue) => {
							const screen = `${request.base}|${issue.project}|${issue.issueType}`;
							let shown = dueOnScreen.get(screen);
							if (!shown) {
								shown = fetch(
									`${request.base}/rest/api/3/issue/${issue.key}/editmeta`,
									{ headers },
								)
									.then(async (response) =>
										response.ok
											? "duedate" in
												(((await response.json()) as { fields?: object })
													.fields ?? {})
											: true,
									)
									.catch(() => true);
								dueOnScreen.set(screen, shown);
							}
							if (!(await shown)) issue.dueDate = null;
						}),
				);
				return { issues };
			}),

		/**
		 * Status of the Jira tickets a session links, keyed by issue key - the
		 * brief's "open / done" chip. One search for all of them; empty when
		 * Jira isn't connected, so the panel just shows no chip.
		 */
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
		 *
		 * ponytail: Slack thread replies only - a DM answered inline, outside a
		 * thread, doesn't count. Add `channelLastTs` here if that's missed.
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
					if (thread)
						out[`slack:${id}`] = {
							stamp: thread.lastReplyTs ?? "",
							byMe: thread.lastReplyByMe,
							...(await slackWatchedThread(id, thread.lastReplyText ?? null)),
						};
				}
				const token = input.prs.length ? await githubAccessToken() : null;
				for (const url of input.prs) {
					const pr =
						(token && (await pullRequestApproval(url, token))) ||
						(await pullRequestState(url));
					if (pr)
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
				const get = async <T>(path: string): Promise<T> => {
					const response = await clickupFetch(path, token);
					if (!response.ok) {
						throw feedError("ClickUp", response.status, await response.text());
					}
					return (await response.json()) as T;
				};
				const [{ user }, { teams }] = await Promise.all([
					get<{ user: { id: number } }>("user"),
					get<{ teams: { id: string }[] }>("team"),
				]);
				type Task = {
					id: string;
					name: string;
					url: string;
					status?: { status?: string };
					priority?: { priority?: string } | null;
					list?: { name?: string };
					creator?: { username?: string };
					text_content?: string | null;
					date_updated?: string | null;
					date_created?: string | null;
					due_date?: string | null;
				};
				// ponytail: first page (100 tasks) per workspace - page on when someone has more.
				const pages = await Promise.all(
					teams.map((team) =>
						get<{ tasks: Task[] }>(
							`team/${team.id}/task?assignees[]=${user.id}&subtasks=true&order_by=updated`,
						),
					),
				);
				return {
					tasks: pages
						.flatMap((page) => page.tasks)
						.map((task) => ({
							id: task.id,
							url: task.url,
							name: task.name,
							status: task.status?.status ?? null,
							priority: task.priority?.priority ?? null,
							list: task.list?.name ?? null,
							creator: task.creator?.username ?? null,
							description: task.text_content || null,
							updated: clickupDate(task.date_updated),
							created: clickupDate(task.date_created),
							dueDate: clickupDate(task.due_date),
						})),
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
						created: item.created_at ?? null,
						comments: item.comments ?? 0,
						body: item.body?.trim().slice(0, 3000) || null,
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
				// strongest first - mine, then my review, then merely named.
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
