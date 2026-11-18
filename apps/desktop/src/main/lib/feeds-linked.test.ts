import { expect, test } from "bun:test";
import {
	airtableRecords,
	airtableView,
	determFeed,
	determMentions,
	type FeedCall,
} from "./feeds";

const json = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200 });

test("airtableView reads base, table and view out of a link", () => {
	expect(
		airtableView(
			"https://airtable.com/appAAAAAAAAAAAAAA/tblBBBBBBBBBBBBBB/viwCCCCCCCCCCCCCC?blocks=hide",
		),
	).toEqual({
		base: "appAAAAAAAAAAAAAA",
		table: "tblBBBBBBBBBBBBBB",
		view: "viwCCCCCCCCCCCCCC",
	});
	expect(airtableView("https://example.com/nothing")).toBeNull();
});

test("determFeed reads organization and query out of a feed link", () => {
	expect(determFeed("https://app.determ.com/123/feed/q/456")).toEqual({
		organization: "123",
		keyword: "456",
	});
	expect(determFeed("https://app.determ.com/123/dashboard")).toBeNull();
});

test("airtableRecords titles rows by the primary field and reads Status", async () => {
	const paths: string[] = [];
	const call: FeedCall = async (path) => {
		paths.push(path);
		if (path.startsWith("meta/"))
			return json({
				tables: [
					{
						id: "tblBBBBBBBBBBBBBB",
						name: "Tasks",
						primaryFieldId: "fldName",
						fields: [
							{ id: "fldName", name: "Name" },
							{ id: "fldStatus", name: "Status" },
						],
					},
				],
			});
		return json({
			records: [
				{
					id: "rec1",
					createdTime: "2026-01-02T00:00:00.000Z",
					fields: { fldName: "Write the launch post", fldStatus: "Todo" },
				},
				{ id: "rec2", fields: {} },
			],
		});
	};
	const rows = await airtableRecords(call, [
		"https://airtable.com/appAAAAAAAAAAAAAA/tblBBBBBBBBBBBBBB/viwCCCCCCCCCCCCCC",
		"not a link",
	]);
	expect(paths[1]).toContain("view=viwCCCCCCCCCCCCCC");
	expect(rows).toEqual([
		{
			id: "rec1",
			url: "https://airtable.com/appAAAAAAAAAAAAAA/tblBBBBBBBBBBBBBB/rec1",
			title: "Write the launch post",
			status: "Todo",
			table: "Tasks",
			created: "2026-01-02T00:00:00.000Z",
		},
		{
			id: "rec2",
			url: "https://airtable.com/appAAAAAAAAAAAAAA/tblBBBBBBBBBBBBBB/rec2",
			title: "Untitled record",
			status: null,
			table: "Tasks",
			created: null,
		},
	]);
});

test("determMentions posts a 7-day scroll and maps each mention", async () => {
	const sent: { path?: string; body?: string } = {};
	const call: FeedCall = async (path, init) => {
		sent.path = path;
		sent.body = init?.body;
		return json({
			mentions: [
				{
					id: 9,
					type: "WEB",
					mention: "  Acme ships a new editor  ",
					url: "https://example.com/post",
					author: "Riley Jones",
					autoSentiment: "POSITIVE",
					keywords: ["acme"],
					insertTime: Date.UTC(2026, 0, 2),
				},
			],
		});
	};
	const rows = await determMentions(call, [
		"https://app.determ.com/123/feed/q/456",
	]);
	expect(sent.path).toBe("v2/organizations/123/keywords/456/mentions/scroll");
	expect(JSON.parse(sent.body ?? "{}").query.feedTime.relative).toBe(
		"LAST_7_DAYS",
	);
	expect(rows).toEqual([
		{
			id: "9",
			url: "https://example.com/post",
			title: "Acme ships a new editor",
			text: "Acme ships a new editor",
			author: "Riley Jones",
			type: "WEB",
			sentiment: "POSITIVE",
			feed: "acme",
			at: "2026-01-02T00:00:00.000Z",
		},
	]);
});
