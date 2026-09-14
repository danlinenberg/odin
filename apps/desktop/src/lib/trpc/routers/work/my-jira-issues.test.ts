import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkRouter } from ".";

/**
 * myJiraIssues against a stubbed Jira.
 *
 * Nothing is mocked at the module level: the token layer reads
 * `ODIN_CONFIG_PATH`, so a temp config with a live-looking access token and a
 * cached cloudId is enough to make `jiraRequestContext()` answer without going
 * near the network. Only `fetch` is replaced, which is also what makes the
 * three JQL queries readable as assertions.
 */

const SITE = "https://example.atlassian.net";
const ME = "712020:3cce6ef2";

/** A comment body in ADF, the shape Jira actually returns. */
function body(mentioned: string | null, text: string) {
	return {
		type: "doc",
		version: 1,
		content: [
			{
				type: "paragraph",
				content: [
					...(mentioned
						? [
								{
									type: "mention",
									attrs: { id: mentioned, text: "@Dan Linenberg" },
								},
								{ type: "hardBreak" },
							]
						: []),
					{ type: "text", text },
				],
			},
		],
	};
}

/** Oldest first, the order Jira returns them in. */
const COMMENTS = [
	{
		author: { displayName: "Tamir Davidov" },
		created: "2026-09-10T09:00:00.000+0300",
		body: body(ME, "the older ask"),
	},
	{
		author: { displayName: "Richu Joseph" },
		created: "2026-09-12T09:00:00.000+0300",
		body: body("633bc4c7", "asking someone else entirely"),
	},
	{
		author: { displayName: "Nadav Rotem" },
		created: "2026-09-14T17:32:58.317+0300",
		body: body(ME, "Shall we close this ticket?"),
	},
	{
		author: { displayName: "Gil Weiss" },
		created: "2026-09-14T18:00:00.000+0300",
		body: body(null, "no idea, not my area"),
	},
];

function issue(key: string, comments?: unknown[]) {
	return {
		key,
		fields: {
			summary: "a ticket",
			status: { name: "In Progress", statusCategory: { name: "In Progress" } },
			priority: { name: "Medium" },
			project: { key: key.split("-")[0], name: "Bug Triage" },
			issuetype: { name: "Bug" },
			reporter: { displayName: "Someone Else" },
			updated: "2026-09-14T10:00:00.000Z",
			...(comments ? { comment: { comments } } : {}),
		},
	};
}

/** The same ticket deliberately comes back from more than one search. */
const RESULTS: Record<string, string[]> = {
	assignee: ["ODIN-1"],
	reporter: ["ODIN-1", "BUGT-2"],
	// OPS-4 is the one the mention search returns because I commented on it,
	// not because anybody named me.
	comment: ["BUGT-2", "BUGT-3", "OPS-4"],
};

const realFetch = globalThis.fetch;
let jqls: string[] = [];
let fieldsAsked = new Map<string, string>();

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "odin-jira-"));
	const path = join(dir, "odin.json");
	writeFileSync(
		path,
		JSON.stringify({
			jiraClientId: "client",
			jiraClientSecret: "secret",
			jiraRedirectUrl: "https://example.com/oauth",
			jiraAccessToken: "access",
			jiraRefreshToken: "refresh",
			jiraTokenExpiresAt: Date.now() + 3_600_000,
			jiraCloudId: "cloud-1",
			jiraSiteUrl: SITE,
		}),
	);
	process.env.ODIN_CONFIG_PATH = path;

	jqls = [];
	fieldsAsked = new Map();
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const json = (payload: unknown) =>
			new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		if (url.pathname.endsWith("/myself")) return json({ accountId: ME });

		const jql = url.searchParams.get("jql") ?? "(no jql sent)";
		jqls.push(jql);
		fieldsAsked.set(jql.split(" ")[0], url.searchParams.get("fields") ?? "");
		const bucket = Object.keys(RESULTS).find((who) => jql.startsWith(who));
		const mentions = bucket === "comment";
		return json({
			issues: (RESULTS[bucket ?? ""] ?? []).map((key) =>
				issue(
					key,
					mentions ? (key === "OPS-4" ? [COMMENTS[1]] : COMMENTS) : undefined,
				),
			),
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.ODIN_CONFIG_PATH;
});

const call = (input?: { includeDone?: boolean }) =>
	createWorkRouter()
		.createCaller({} as never)
		.myJiraIssues(input);

describe("myJiraIssues", () => {
	it("asks Jira the three ways a ticket becomes mine", async () => {
		await call();
		expect(jqls.map((jql) => jql.split(" AND ")[0]).sort()).toEqual([
			"assignee = currentUser()",
			"comment ~ currentUser()",
			"reporter = currentUser()",
		]);
	});

	it("finds mentions through the comment body, open ones only by default", async () => {
		await call();
		const mentions = jqls.find((jql) => jql.startsWith("comment"));
		expect(mentions).toBe(
			"comment ~ currentUser() AND statusCategory != Done ORDER BY updated DESC",
		);
	});

	it("includes done tickets when asked", async () => {
		await call({ includeDone: true });
		expect(jqls.every((jql) => !jql.includes("statusCategory"))).toBe(true);
	});

	it("labels each row with why it is in the list", async () => {
		const { issues } = await call();
		expect(issues.map((i) => [i.key, i.role])).toEqual([
			["ODIN-1", "assigned"],
			["BUGT-2", "reported"],
			["BUGT-3", "mentioned"],
		]);
	});

	it("shows a ticket once, under its strongest claim", async () => {
		const { issues } = await call();
		expect(issues.map((i) => i.key)).toEqual(["ODIN-1", "BUGT-2", "BUGT-3"]);
	});

	it("shows the comment that named me, newest first", async () => {
		const { issues } = await call();
		const mentioned = issues.find((i) => i.role === "mentioned");
		expect(mentioned?.mention).toEqual({
			author: "Nadav Rotem",
			at: "2026-09-14T17:32:58.317+0300",
			text: "@Dan Linenberg Shall we close this ticket?",
		});
	});

	it("leaves assigned and filed rows without a comment", async () => {
		const { issues } = await call();
		expect(
			issues.filter((i) => i.role !== "mentioned").map((i) => i.mention),
		).toEqual([null, null]);
	});

	it("only pays for comment bodies on the mention search", async () => {
		await call();
		expect(fieldsAsked.get("comment")).toContain(",comment");
		expect(fieldsAsked.get("assignee")).not.toContain("comment");
	});

	it("drops a ticket I commented on but was never named in", async () => {
		const { issues } = await call();
		expect(issues.map((i) => i.key)).not.toContain("OPS-4");
	});

	it("links rows to the site host, not the OAuth gateway", async () => {
		const { issues } = await call();
		expect(issues[0].url).toBe(`${SITE}/browse/ODIN-1`);
	});
});
