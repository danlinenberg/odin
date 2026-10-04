import { describe, expect, it } from "bun:test";
import type { AllItem } from "../all/all-items";
import { duplicateOf, type LedgerRow } from "./duplicates";

function item(
	source: AllItem["source"],
	key: string,
	title: string,
	extra: Partial<AllItem> = {},
): AllItem {
	return {
		key,
		source,
		to: "/all" as AllItem["to"],
		title,
		url: null,
		person: null,
		status: null,
		context: null,
		priority: null,
		urgency: null,
		at: 0,
		dueDate: null,
		mention: null,
		body: null,
		details: [],
		launch: { key, title, description: null, contact: null, brief: "" },
		...extra,
	};
}

const slackPing: LedgerRow = {
	source: "reactions",
	externalId: "C0B910ZR3RB:1791112730.416039",
	title: "CS request: Revert fine-tune for purchased profile",
	startedAt: 1,
};
const jiraRun: LedgerRow = {
	source: "jira",
	externalId: "CRR-919",
	title: "CRR-919: CS request: Revert fine-tune for purchased profile",
	startedAt: 1,
};

describe("duplicateOf", () => {
	it("matches a Jira row to the Slack ping already worked, by title", () => {
		const jira = item(
			"Jira",
			"CRR-919",
			"CRR-919: CS request: Revert fine-tune for purchased profile",
		);
		expect(duplicateOf(jira, [slackPing])).toBe(slackPing);
	});

	it("matches a Slack row linking a ticket already worked, by key", () => {
		const slack = item("Slack", "C1:2", "can you prioritize this?", {
			body: "<https://imagen-ai.atlassian.net/browse/CRR-919|CS request> followed up again",
		});
		expect(duplicateOf(slack, [jiraRun])).toBe(jiraRun);
	});

	it("ignores tickets a Jira description only cites", () => {
		const jira = item("Jira", "CRR-950", "CRR-950: Restore a lost preset", {
			body: "Same fix as CRR-919",
		});
		expect(duplicateOf(jira, [jiraRun])).toBeNull();
	});

	it("ignores short or script-only titles that collide by accident", () => {
		const short = item("Slack", "C1:3", "Report issue");
		expect(
			duplicateOf(short, [{ ...slackPing, title: "report issue" }]),
		).toBeNull();
		const hebrew = item("Slack", "C1:4", "אפשר לבדוק את זה בבקשה היום?");
		expect(duplicateOf(hebrew, [{ ...slackPing, title: "שלום" }])).toBeNull();
	});
});
