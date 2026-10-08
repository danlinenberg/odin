import { describe, expect, it } from "bun:test";
import { linkKind } from "./link-kind";

const ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

describe("linkKind", () => {
	it("routes each connector's links", () => {
		expect(
			linkKind("https://x.slack.com/archives/C1/p1791382321749849?thread_ts=1"),
		).toMatchObject({ kind: "slack" });
		expect(linkKind("https://github.com/a/b/pull/12")).toEqual({
			kind: "github",
			repo: "a/b",
			number: "12",
		});
		expect(linkKind("https://x.atlassian.net/browse/BUGT-12")).toEqual({
			kind: "jira",
			key: "BUGT-12",
		});
		expect(
			linkKind("https://x.atlassian.net/jira/board/1?selectedIssue=CRR-9"),
		).toEqual({ kind: "jira", key: "CRR-9" });
		expect(linkKind("CRR-9")).toEqual({ kind: "jira", key: "CRR-9" });
		expect(linkKind("https://app.clickup.com/t/86c1ab2cd")).toEqual({
			kind: "clickup",
			id: "86c1ab2cd",
		});
		expect(linkKind("https://app.clickup.com/t/9012345/DEV-42")).toEqual({
			kind: "clickup",
			id: "DEV-42",
			teamId: "9012345",
		});
		expect(linkKind("https://example.com/x")).toBeNull();
	});

	it("takes a Notion page id, not the title's hex letters before it", () => {
		expect(linkKind(`https://www.notion.so/ws/Add-feed-${ID}`)).toEqual({
			kind: "notion",
			id: ID,
		});
		// The API's own page urls, which the Notion feed passes on.
		expect(linkKind(`https://app.notion.com/p/Add-feed-${ID}`)).toEqual({
			kind: "notion",
			id: ID,
		});
		expect(linkKind(`https://www.notion.so/ws/0000?v=1&p=${ID}`)).toEqual({
			kind: "notion",
			id: ID,
		});
	});
});
