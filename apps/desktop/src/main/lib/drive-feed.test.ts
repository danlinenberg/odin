import { describe, expect, it } from "bun:test";
import { driveShareRows } from "./feeds";
import {
	allMailbox,
	decodeBody,
	decodeHeader,
	fetchSections,
} from "./gmail-imap";

describe("driveShareRows", () => {
	it("turns Drive's share emails into rows, one per file, newest first", () => {
		const rows = driveShareRows([
			{
				subject: 'Spreadsheet shared with you: "Budget Q3"',
				from: '"Riley Jones (via Google Sheets)" <drive-shares-dm-noreply@google.com>',
				body: "I've shared an item with you:\r\n\r\nBudget Q3\r\nhttps://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing&ts=1\r\n",
				receivedAt: "2026-03-18T09:00:00.000Z",
			},
			{
				subject: 'Document shared with you: "Plan"',
				from: '"Alex (via Google Docs)" <drive-shares-dm-noreply@google.com>',
				body: "https://docs.google.com/document/d/doc9/edit",
				receivedAt: "2026-03-19T09:00:00.000Z",
			},
			{
				subject: 'Spreadsheet shared with you: "Budget Q3"',
				from: '"Riley Jones (via Google Sheets)" <drive-shares-dm-noreply@google.com>',
				body: "https://docs.google.com/spreadsheets/d/abc123/edit",
				receivedAt: "2026-03-10T09:00:00.000Z",
			},
			{ subject: "No link", from: "x", body: "nothing here", receivedAt: null },
		]);
		expect(rows.map((row) => row.name)).toEqual(["Plan", "Budget Q3"]);
		expect(rows[1]).toMatchObject({
			id: "abc123",
			kind: "Spreadsheet",
			sharedBy: "Riley Jones",
			sharedAt: "2026-03-18T09:00:00.000Z",
			url: "https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing&ts=1",
		});
	});
});

describe("gmail-imap", () => {
	it("decodes encoded headers and bodies", () => {
		expect(decodeHeader("=?UTF-8?B?16nXnNeV150=?= =?UTF-8?Q?_world?=")).toBe(
			"שלום world",
		);
		expect(
			decodeBody(
				"Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable",
				"https://docs.google.com/d/x?a=3D1&b=\r\n=3D2",
			),
		).toBe("https://docs.google.com/d/x?a=1&b=2");
	});

	it("finds All Mail by its \\All flag and splits a FETCH by section", () => {
		expect(
			allMailbox([
				[{ prefix: '* LIST (\\HasNoChildren) "/" "INBOX"', literal: null }],
				[
					{
						prefix: '* LIST (\\All \\HasNoChildren) "/" "[Gmail]/Alle"',
						literal: null,
					},
				],
			]),
		).toBe("[Gmail]/Alle");
		const found = fetchSections([
			{
				prefix:
					'* 3 FETCH (UID 42 INTERNALDATE "17-Mar-2026 05:52:34 +0000" BODY[1] {5}',
				literal: "hello",
			},
			{ prefix: ")", literal: null },
		]);
		expect(found).toEqual({
			uid: "42",
			internalDate: "17-Mar-2026 05:52:34 +0000",
			sections: { "1": "hello" },
		});
	});
});
