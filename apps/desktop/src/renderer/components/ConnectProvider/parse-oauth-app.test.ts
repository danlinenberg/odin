import { describe, expect, test } from "bun:test";
import { parseOAuthApp } from "./parse-oauth-app";

const APP = {
	clientId: "id-1",
	clientSecret: 'se"cret',
	redirectUrl: "https://example.com/airtable.html",
};

describe("parseOAuthApp", () => {
	test("reads the provider's lines out of a pasted odin.json", () => {
		const text = `{
  "slackClientId": "other",
  "airtableClientId": "id-1",
  "airtableClientSecret": "se\\"cret",
  "airtableRedirectUrl": "https://example.com/airtable.html"
}`;
		expect(parseOAuthApp("airtable", text)).toEqual({ app: APP, missing: [] });
	});

	test("reads grep output without braces, and env lines", () => {
		const grep = `"airtableClientId": "id-1",\n"airtableClientSecret": "se\\"cret",\n"airtableRedirectUrl": "https://example.com/airtable.html",`;
		expect(parseOAuthApp("airtable", grep).app).toEqual(APP);
		const env = [
			"ODIN_AIRTABLE_CLIENT_ID=id-1",
			`ODIN_AIRTABLE_CLIENT_SECRET='se"cret'`,
			'ODIN_AIRTABLE_REDIRECT_URL="https://example.com/airtable.html"',
		].join("\n");
		expect(parseOAuthApp("airtable", env).app).toEqual(APP);
	});

	test("names the keys that are missing", () => {
		expect(parseOAuthApp("notion", `"notionClientId": "x"`)).toEqual({
			app: null,
			missing: ["notionClientSecret", "notionRedirectUrl"],
		});
	});
});
