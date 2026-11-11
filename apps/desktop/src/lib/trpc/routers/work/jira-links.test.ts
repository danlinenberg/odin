import { describe, expect, it } from "bun:test";
import { jiraIssueLinks } from "./jira-links";

const text = (value: string) => ({ type: "text", text: value });

describe("jiraIssueLinks", () => {
	it("collects the ticket's links from description, people's comments and remote links", () => {
		const issue = {
			fields: {
				description: {
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [
								text("PRs: https://github.com/acme/api/pull/12."),
								{
									type: "text",
									text: "web",
									marks: [
										{ attrs: { href: "https://github.com/acme/web/pull/7" } },
									],
								},
								{
									type: "inlineCard",
									attrs: { url: "https://acme.slack.com/archives/C1/p1" },
								},
								text("again https://github.com/acme/api/pull/12"),
								text("self https://acme.atlassian.net/browse/OPS-1"),
							],
						},
					],
				},
				comment: {
					comments: [
						{
							author: { accountType: "app" },
							body: { content: [text("https://example.com/boilerplate")] },
						},
						{
							author: { accountType: "atlassian" },
							body: { content: [text("see https://example.com/notes")] },
						},
					],
				},
			},
		};
		const remote = [{ object: { url: "https://github.com/acme/ops/pull/3" } }];
		expect(jiraIssueLinks(issue, remote, "OPS-1")).toEqual([
			"https://github.com/acme/api/pull/12",
			"https://github.com/acme/web/pull/7",
			"https://acme.slack.com/archives/C1/p1",
			"https://example.com/notes",
			"https://github.com/acme/ops/pull/3",
		]);
	});

	it("is empty for a ticket with nothing on it", () => {
		expect(jiraIssueLinks({})).toEqual([]);
	});
});
