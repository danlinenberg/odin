import { describe, expect, it } from "bun:test";
import type { Pane } from "shared/tabs-types";
import type { AllItem } from "../all/all-items";
import { duplicateOf, type LedgerRow, liveRows } from "./duplicates";

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
		createdAt: 0,
		dueDate: null,
		mention: null,
		ask: { kind: "own", at: 0 },
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

	it("matches a Sentry DM to the channel alert a live session is on", () => {
		// The same issue, alerted in a channel and DMed a minute later: the
		// titles differ, only the issue id in the link is shared.
		const channel = {
			type: "terminal",
			id: "p1",
			name: "Claude",
			odinSource: "reactions",
			odinPageId: "C03RZFXG2FQ:1793012184.474519",
			odinTaskTitle: "Fix should_display_on_shop crash in sell_profile",
			odinBrief:
				"AttributeError (https://imagenai.sentry.io/issues/7812764568/?referrer=slack&environment=prod)",
		} as Pane;
		const dm = item(
			"Slack",
			"D099FEA5JKZ:1793012236.845379",
			"[web-server] AttributeError: 'NoneType' object has no attribute",
			{
				body: "Alert triggered\nAttributeError (https://imagenai.sentry.io/issues/7812764568/?referrer=issue_alert-slack)",
			},
		);
		const [live] = liveRows([channel], 1);
		expect(duplicateOf(dm, [live])).toBe(live);
		// Another Sentry issue is not the same ask.
		const other = item("Slack", "D1:2", "KeyError somewhere else entirely", {
			body: "https://imagenai.sentry.io/issues/7812764999/",
		});
		expect(duplicateOf(other, [live])).toBeNull();
		// A finished session no longer counts.
		expect(liveRows([{ ...channel, completed: true }], 1)).toEqual([]);
	});
});
