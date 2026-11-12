/** A Notion database page as a row of the Tasks view. No Electron: the phone server on a remote host uses it too. */

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
	/** Every Notion property, name → display string - for "show all fields". */
	fields: Record<string, string>;
}

export interface NotionRichText {
	plain_text?: string;
}

export type NotionPropertyValue = {
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
export function propToString(value: NotionPropertyValue): string {
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

export interface NotionPage {
	object: string;
	id: string;
	url: string;
	created_time: string;
	last_edited_time?: string;
	parent?: { database_id?: string };
	properties: Record<string, NotionPropertyValue>;
}

export function plainText(parts: NotionRichText[] | undefined): string {
	return (parts ?? []).map((part) => part.plain_text ?? "").join("");
}

export function firstSlackUrl(page: NotionPage): string | null {
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

export function normalizePage(page: NotionPage): SlackQueueRow {
	const entries = Object.entries(page.properties);
	const props = Object.values(page.properties);
	const titleProp = props.find((value) => value.type === "title");
	// Prefer the property literally named "Status" - schemas often carry
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
