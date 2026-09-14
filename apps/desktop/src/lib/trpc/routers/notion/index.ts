import { TRPCError } from "@trpc/server";
import { refreshNotionToken } from "main/lib/notion-token";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	readOdinConfig,
	resolveNotionToken,
	updateOdinConfig,
} from "../odin-config";

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
	people?: { name?: string }[];
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
				/** Repo to auto-provision a workspace from when none exists. */
				defaultRepoPath:
					process.env.DAN_DEFAULT_REPO ?? fileConfig.defaultRepo ?? null,
			};
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
				updateOdinConfig({ notionTaskDbId: input.databaseId.trim() });
				return { ok: true };
			}),

		queryDatabase: publicProcedure
			.input(z.object({ databaseId: z.string().min(1) }))
			.query(
				async ({
					input,
				}): Promise<{ rows: SlackQueueRow[]; dbTitle: string | null }> => {
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
					const rows = results
						.filter((page) => page.object === "page")
						.map(normalizePage);
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
