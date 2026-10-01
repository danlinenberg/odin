import { TRPCError } from "@trpc/server";
import { refreshNotionToken } from "main/lib/notion-token";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	readOdinConfig,
	resolveNotionToken,
	updateOdinConfig,
} from "../odin-config";
import {
	hasStatus,
	isAssignment,
	type NotionComment,
	openMentionThreads,
	propsNamingMe,
} from "./mentions";

/**
 * Notion access for the Tasks view: list the databases the integration can
 * see, remember which one is picked, and read its rows.
 *
 * Runs in the main process (renderer fetches to api.notion.com would be
 * blocked by CORS). The token is never sent to the renderer.
 */

const NOTION_VERSION = "2022-06-28";

function getNotionToken(): string | null {
	return resolveNotionToken();
}

/** A Notion request that survives an expired OAuth access token. */
async function notionFetch(
	url: string,
	init: RequestInit & { headers: Record<string, string> },
): Promise<Response> {
	const token = getNotionToken();
	if (!token) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "No Notion token found",
		});
	}
	const send = (bearer: string) =>
		fetch(url, {
			...init,
			headers: {
				...init.headers,
				Authorization: `Bearer ${bearer}`,
				"Notion-Version": NOTION_VERSION,
			},
		});
	const first = await send(token);
	if (first.status !== 401) return first;
	const refreshed = await refreshNotionToken();
	return refreshed ? send(refreshed) : first;
}

export interface SlackQueueRow {
	pageId: string;
	pageUrl: string;
	title: string;
	slackUrl: string | null;
	status: string | null;
	priority: string | null;
	contact: string | null;
	assignee: string | null;
	channel: string | null;
	date: string | null;
	updatedAt: string | null;
	createdTime: string;
	/** Every Notion property, name → display string — for "show all fields". */
	fields: Record<string, string>;
}

interface NotionRichText {
	plain_text?: string;
}

type NotionPropertyValue = {
	type?: string;
	title?: NotionRichText[];
	rich_text?: NotionRichText[];
	url?: string | null;
	status?: { name?: string } | null;
	select?: { name?: string } | null;
	multi_select?: { name?: string }[];
	people?: { id?: string; name?: string }[];
	date?: { start?: string; end?: string } | null;
	last_edited_time?: string;
	created_time?: string;
	number?: number | null;
	checkbox?: boolean;
	email?: string | null;
	phone_number?: string | null;
	formula?: { string?: string; number?: number; boolean?: boolean };
};

/** Render any Notion property to a human display string (empty = omit). */
function propToString(value: NotionPropertyValue): string {
	switch (value.type) {
		case "title":
			return plainText(value.title);
		case "rich_text":
			return plainText(value.rich_text);
		case "url":
			return value.url ?? "";
		case "email":
			return value.email ?? "";
		case "phone_number":
			return value.phone_number ?? "";
		case "status":
			return value.status?.name ?? "";
		case "select":
			return value.select?.name ?? "";
		case "multi_select":
			return (value.multi_select ?? []).map((o) => o.name).join(", ");
		case "people":
			return (value.people ?? []).map((p) => p.name).join(", ");
		case "date":
			return [value.date?.start, value.date?.end].filter(Boolean).join(" → ");
		case "last_edited_time":
			return value.last_edited_time
				? new Date(value.last_edited_time).toLocaleString()
				: "";
		case "created_time":
			return value.created_time
				? new Date(value.created_time).toLocaleString()
				: "";
		case "number":
			return value.number != null ? String(value.number) : "";
		case "checkbox":
			return value.checkbox ? "✓" : "";
		case "formula":
			return (
				value.formula?.string ??
				(value.formula?.number != null ? String(value.formula.number) : "") ??
				""
			);
		default:
			return "";
	}
}

interface NotionPage {
	object: string;
	id: string;
	url: string;
	created_time: string;
	last_edited_time?: string;
	parent?: { database_id?: string };
	properties: Record<string, NotionPropertyValue>;
}

function plainText(parts: NotionRichText[] | undefined): string {
	return (parts ?? []).map((part) => part.plain_text ?? "").join("");
}

function firstSlackUrl(page: NotionPage): string | null {
	const entries = Object.entries(page.properties);
	// Prefer a url property whose name mentions slack, then any slack.com url,
	// then a rich_text property containing a slack archives link.
	const urlProps = entries.filter(([, value]) => value.type === "url");
	const named = urlProps.find(([name]) => /slack/i.test(name));
	if (named?.[1].url) return named[1].url;
	const anySlack = urlProps.find(([, value]) =>
		value.url?.includes("slack.com"),
	);
	if (anySlack?.[1].url) return anySlack[1].url ?? null;
	for (const [, value] of entries) {
		if (value.type !== "rich_text") continue;
		const text = plainText(value.rich_text);
		const match = text.match(/https:\/\/\S*slack\.com\/\S+/);
		if (match) return match[0];
	}
	return null;
}

function normalizePage(page: NotionPage): SlackQueueRow {
	const entries = Object.entries(page.properties);
	const props = Object.values(page.properties);
	const titleProp = props.find((value) => value.type === "title");
	// Prefer the property literally named "Status" — schemas often carry
	// several status/select properties (Priority, Channel, ...).
	const statusProp =
		entries.find(
			([name, value]) => value.type === "status" && /^status$/i.test(name),
		)?.[1] ?? props.find((value) => value.type === "status");
	const peopleProp = props.find(
		(value) => value.type === "people" && (value.people?.length ?? 0) > 0,
	);
	const contactProp = entries.find(
		([name, value]) => value.type === "rich_text" && /contact/i.test(name),
	)?.[1];
	const channelProp = entries.find(
		([name, value]) =>
			(value.type === "multi_select" || value.type === "select") &&
			/channel/i.test(name),
	)?.[1];
	const priorityProp = entries.find(
		([name, value]) =>
			(value.type === "status" || value.type === "select") &&
			/priority/i.test(name),
	)?.[1];
	const contactSelectProp = entries.find(
		([name, value]) => value.type === "select" && /^contact$/i.test(name),
	)?.[1];
	const dateProp = props.find((value) => value.type === "date");
	const updatedProp = props.find((value) => value.type === "last_edited_time");
	return {
		pageId: page.id,
		pageUrl: page.url,
		title: plainText(titleProp?.title) || "(untitled)",
		slackUrl: firstSlackUrl(page),
		status: statusProp?.status?.name ?? null,
		priority: priorityProp?.status?.name ?? priorityProp?.select?.name ?? null,
		contact: contactSelectProp?.select?.name ?? null,
		assignee:
			peopleProp?.people?.[0]?.name ??
			(plainText(contactProp?.rich_text) || null),
		channel:
			channelProp?.multi_select?.[0]?.name ?? channelProp?.select?.name ?? null,
		date: dateProp?.date?.start ?? null,
		updatedAt: updatedProp?.last_edited_time ?? null,
		createdTime: page.created_time,
		fields: Object.fromEntries(
			entries
				.map(([name, value]) => [name, propToString(value)] as const)
				.filter(([, str]) => str.length > 0),
		),
	};
}

/** GET/POST that must succeed — a failure becomes a readable TRPCError. */
async function notionJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const response = await notionFetch(url, {
		...init,
		headers: { "Content-Type": "application/json" },
	});
	if (!response.ok) {
		const body = await response.text();
		throw new TRPCError({
			code: response.status === 403 ? "FORBIDDEN" : "BAD_REQUEST",
			message: `Notion request failed (${response.status}): ${body.slice(0, 300)}`,
		});
	}
	return (await response.json()) as T;
}

/**
 * Every database the integration can see, cached for half an hour — the list
 * barely changes, and walking it costs a request per 100 databases.
 */
let databaseCache: { at: number; databases: unknown[] } | null = null;
async function listAllDatabases<T>(): Promise<T[]> {
	if (databaseCache && Date.now() - databaseCache.at < 30 * 60_000)
		return databaseCache.databases as T[];
	const databases: T[] = [];
	let cursor: string | undefined;
	// ponytail: first 1,000 databases the integration can see.
	for (let page = 0; page < 10; page++) {
		const result = await notionJson<{
			results?: T[];
			has_more?: boolean;
			next_cursor?: string | null;
		}>("https://api.notion.com/v1/search", {
			method: "POST",
			body: JSON.stringify({
				filter: { property: "object", value: "database" },
				page_size: 100,
				...(cursor ? { start_cursor: cursor } : {}),
			}),
		});
		databases.push(...(result.results ?? []));
		if (!result.has_more || !result.next_cursor) break;
		cursor = result.next_cursor;
	}
	databaseCache = { at: Date.now(), databases };
	return databases;
}

/**
 * Rows of every task database (one with a status) whose people property —
 * Assignee, Owner, … — names me, edited in the last month. Each database is
 * asked directly, so a busy one can't crowd another out of a recent-pages
 * window. Meeting-note databases list me under Attendees but have no status.
 */
async function fetchAssignedRows(
	meId: string,
	skip: (databaseId: string) => boolean,
): Promise<SlackQueueRow[]> {
	type Database = {
		id: string;
		properties?: Record<string, { type?: string }>;
	};
	const databases = await listAllDatabases<Database>();
	const taskDatabases = databases
		.filter((db) => !skip(db.id) && hasStatus(db.properties ?? {}))
		.map((db) => ({
			id: db.id,
			people: Object.entries(db.properties ?? {})
				.filter(
					([name, value]) => value.type === "people" && isAssignment(name),
				)
				.map(([name]) => name),
		}))
		.filter((db) => db.people.length > 0);

	const rows: SlackQueueRow[] = [];
	let failed = 0;
	for (let i = 0; i < taskDatabases.length; i += 3) {
		await Promise.all(
			taskDatabases.slice(i, i + 3).map(async (db) => {
				const result = await notionJson<{ results?: NotionPage[] }>(
					`https://api.notion.com/v1/databases/${db.id}/query`,
					{
						method: "POST",
						body: JSON.stringify({
							page_size: 50,
							filter: {
								and: [
									{
										or: db.people.map((property) => ({
											property,
											people: { contains: meId },
										})),
									},
									{
										timestamp: "last_edited_time",
										last_edited_time: { past_month: {} },
									},
								],
							},
						}),
					},
				).catch((error: Error) => {
					// One unreadable database mustn't sink the rest — but say so.
					failed++;
					console.warn(
						`[notion] assigned-to-me query failed for database ${db.id}: ${error.message}`,
					);
					return null;
				});
				for (const page of result?.results ?? []) {
					const naming = propsNamingMe(page.properties ?? {}, meId).filter(
						isAssignment,
					);
					const row = normalizePage(page);
					rows.push({
						...row,
						// The row keeps its own status, so finished ones sink.
						status:
							row.status ??
							Object.entries(page.properties ?? {}).find(
								([name, value]) =>
									value.type === "select" && /status/i.test(name),
							)?.[1].select?.name ??
							"Assigned",
						fields: {
							...row.fields,
							"Why it's here": `${naming.join(", ")}: you`,
						},
					});
				}
			}),
		);
	}
	console.log(
		`[notion] assigned to me: ${databases.length} databases seen, ${taskDatabases.length} with a status and an assignee field, ${failed} failed, ${rows.length} rows`,
	);
	return rows;
}

/**
 * What Notion's inbox calls "mentioned you": pages whose people property
 * (Assignee, Owner, …) names me, and open comment threads that @-mention me.
 *
 * Notion has no "my mentions" endpoint, so this asks each task database
 * and reads the comments on pages edited lately. "Me" is whoever signed
 * in: the OAuth bot's owner. Rows of the picked database are skipped —
 * that feed already lists them.
 */
async function fetchMentionRows(
	skipDatabaseId: string,
): Promise<SlackQueueRow[]> {
	const me = await notionJson<{
		bot?: { owner?: { user?: { id?: string } } };
	}>("https://api.notion.com/v1/users/me");
	const meId = me.bot?.owner?.user?.id;
	// An internal-integration token belongs to the workspace, not a person.
	if (!meId) return [];

	const sameId = (a?: string, b?: string) =>
		!!a && !!b && a.replaceAll("-", "") === b.replaceAll("-", "");
	const rows = await fetchAssignedRows(meId, (id) =>
		sameId(id, skipDatabaseId),
	);

	// ponytail: page-level comments on the 30 most recently edited pages from
	// the last 14 days. Inline (block) comments, body @-mentions and older
	// pages are missed — reading those means walking every block, which
	// Notion's 3 req/s won't carry on a 2-minute poll.
	const since = Date.now() - 14 * 24 * 60 * 60_000;
	const search = await notionJson<{ results?: NotionPage[] }>(
		"https://api.notion.com/v1/search",
		{
			method: "POST",
			body: JSON.stringify({
				filter: { property: "object", value: "page" },
				sort: { direction: "descending", timestamp: "last_edited_time" },
				page_size: 30,
			}),
		},
	);
	const commentPages = (search.results ?? []).filter(
		(page) =>
			new Date(page.last_edited_time ?? 0).getTime() >= since &&
			!sameId(page.parent?.database_id, skipDatabaseId),
	);

	const names = new Map<string, Promise<string | null>>();
	const nameOf = (userId: string) => {
		let name = names.get(userId);
		if (!name) {
			name = notionJson<{ name?: string }>(
				`https://api.notion.com/v1/users/${userId}`,
			).then(
				(user) => user.name ?? null,
				() => null,
			);
			names.set(userId, name);
		}
		return name;
	};

	let forbidden = 0;
	for (let i = 0; i < commentPages.length; i += 3) {
		await Promise.all(
			commentPages.slice(i, i + 3).map(async (page) => {
				let comments: NotionComment[];
				try {
					comments =
						(
							await notionJson<{ results?: NotionComment[] }>(
								`https://api.notion.com/v1/comments?block_id=${page.id}&page_size=100`,
							)
						).results ?? [];
				} catch (error) {
					if (error instanceof TRPCError && error.code === "FORBIDDEN")
						forbidden++;
					return;
				}
				const title =
					plainText(
						Object.values(page.properties ?? {}).find(
							(value) => value.type === "title",
						)?.title,
					) || "(untitled)";
				for (const thread of openMentionThreads(comments, meId)) {
					const text = plainText(thread.comment.rich_text).trim();
					const from = await nameOf(thread.comment.created_by.id);
					rows.push({
						pageId: thread.discussionId,
						pageUrl: `${page.url}?d=${thread.discussionId.replaceAll("-", "")}`,
						title: `${title}: ${text.slice(0, 80) || "comment"}`,
						slackUrl: null,
						status: "Mentioned",
						priority: null,
						contact: null,
						assignee: from,
						channel: null,
						date: thread.comment.created_time,
						updatedAt: thread.latestAt,
						createdTime: thread.comment.created_time,
						fields: {
							Page: title,
							...(from ? { From: from } : {}),
							Comment: text,
						},
					});
				}
			}),
		);
	}
	if (commentPages.length > 0 && forbidden === commentPages.length) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				'Notion won\'t show Odin comments. In notion.so/profile/integrations, open Odin → Capabilities, turn on "Read comments", then reconnect Notion.',
		});
	}
	return rows.sort((a, b) =>
		(b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
	);
}

export const createNotionRouter = () => {
	return router({
		/** Set the "Status" property of a queue row (e.g. In progress / Done). */
		updateStatus: publicProcedure
			.input(
				z.object({
					pageId: z.string().min(1),
					status: z.enum(["Not started", "In progress", "Rejected", "Done"]),
				}),
			)
			.mutation(async ({ input }) => {
				const response = await notionFetch(
					`https://api.notion.com/v1/pages/${input.pageId}`,
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							properties: { Status: { status: { name: input.status } } },
						}),
					},
				);
				if (!response.ok) {
					const body = await response.text();
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Notion update failed (${response.status}): ${body.slice(0, 300)}`,
					});
				}
				return { ok: true };
			}),
		/** Config for the Odin views — env first, ~/.config/odin.json fallback. */
		getConfig: publicProcedure.query(() => {
			const fileConfig = readOdinConfig();
			return {
				hasToken: getNotionToken() !== null,
				defaultDatabaseId:
					process.env.SLACK_QUEUE_NOTION_DB_ID ??
					fileConfig.notionTaskDbId ??
					fileConfig.slackQueueDbId ??
					null,
				includeMentions: fileConfig.notionMentions === true,
			};
		}),

		/** Remember whether @-mention comment threads show as tasks. */
		setMentions: publicProcedure
			.input(z.object({ enabled: z.boolean() }))
			.mutation(({ input }) => {
				updateOdinConfig({ notionMentions: input.enabled });
				return { ok: true };
			}),

		/** Every database this token can see — the Tasks view's picker. */
		listDatabases: publicProcedure.query(async () => {
			const response = await notionFetch("https://api.notion.com/v1/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					filter: { property: "object", value: "database" },
					sort: { direction: "descending", timestamp: "last_edited_time" },
					page_size: 100,
				}),
			});
			if (!response.ok) {
				const body = await response.text();
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Notion search failed (${response.status}): ${body.slice(0, 300)}`,
				});
			}
			// ponytail: first 100 databases, no paging — a workspace with more
			// than that needs a search box, not a longer dropdown.
			const payload = (await response.json()) as {
				results?: {
					id: string;
					url?: string;
					title?: NotionRichText[];
				}[];
			};
			return (payload.results ?? []).map((db) => ({
				id: db.id,
				url: db.url ?? null,
				title: plainText(db.title) || "(untitled database)",
			}));
		}),

		/** Remember the picked database in ~/.config/odin.json ("" clears it). */
		setDatabase: publicProcedure
			.input(z.object({ databaseId: z.string() }))
			.mutation(({ input }) => {
				// Clearing drops the legacy key too, or the old pick comes back.
				const databaseId = input.databaseId.trim();
				updateOdinConfig({
					notionTaskDbId: databaseId,
					...(databaseId ? {} : { slackQueueDbId: "" }),
				});
				return { ok: true };
			}),

		queryDatabase: publicProcedure
			.input(
				z.object({
					databaseId: z.string(),
					mentions: z.boolean().optional(),
				}),
			)
			.query(
				async ({
					input,
				}): Promise<{ rows: SlackQueueRow[]; dbTitle: string | null }> => {
					const mentionRows = input.mentions
						? fetchMentionRows(input.databaseId)
						: null;
					// Awaited below; this only stops a failed DB query first from
					// leaving it an unhandled rejection.
					mentionRows?.catch(() => {});
					// Mentions alone, no database picked.
					if (!input.databaseId)
						return { rows: (await mentionRows) ?? [], dbTitle: null };
					const headers = { "Content-Type": "application/json" };
					// Every row, no filter — the view tabs/groups client-side. Paginate
					// past Notion's 100-row page cap (cap total so a huge DB can't hang).
					const results: NotionPage[] = [];
					let cursor: string | undefined;
					for (let page = 0; page < 10; page++) {
						const queryResponse = await notionFetch(
							`https://api.notion.com/v1/databases/${input.databaseId}/query`,
							{
								method: "POST",
								headers,
								body: JSON.stringify({
									page_size: 100,
									...(cursor ? { start_cursor: cursor } : {}),
									sorts: [
										{ timestamp: "created_time", direction: "descending" },
									],
								}),
							},
						);
						if (!queryResponse.ok) {
							const body = await queryResponse.text();
							throw new TRPCError({
								code: "BAD_REQUEST",
								message: `Notion query failed (${queryResponse.status}): ${body.slice(0, 300)}`,
							});
						}
						const payload = (await queryResponse.json()) as {
							results?: NotionPage[];
							has_more?: boolean;
							next_cursor?: string | null;
						};
						results.push(...(payload.results ?? []));
						if (!payload.has_more || !payload.next_cursor) break;
						cursor = payload.next_cursor;
					}
					const dbResponse = await notionFetch(
						`https://api.notion.com/v1/databases/${input.databaseId}`,
						{ headers },
					);
					const dbPayload = dbResponse.ok
						? ((await dbResponse.json()) as {
								title?: { plain_text?: string }[];
							})
						: null;
					// Mentions first, so their group leads the view.
					const rows = [
						...((await mentionRows) ?? []),
						...results
							.filter((page) => page.object === "page")
							.map(normalizePage),
					];
					return {
						rows,
						dbTitle:
							dbPayload?.title
								?.map((part) => part.plain_text ?? "")
								.join("")
								.trim() || null,
					};
				},
			),
	});
};
