import { describe, expect, test } from "bun:test";
import {
	githubRef,
	jiraRef,
	type SweepDeps,
	type SweepItem,
	sweepItem,
} from "./sweep";

const item = (over: Partial<SweepItem> = {}): SweepItem => ({
	key: "task:t1",
	source: "Tasks",
	title: "Chase the export timeout",
	...over,
});

/** Nothing reachable, unless a test says otherwise. */
const deps = (over: Partial<SweepDeps> = {}): SweepDeps => ({
	jiraStatus: async () => null,
	githubState: async () => null,
	slackThread: async () => null,
	...over,
});

describe("finding the reference", () => {
	test("a PR link, wherever it sits", () => {
		expect(
			githubRef(item({ detail: "see https://github.com/odin/odin/pull/42" })),
		).toEqual({
			kind: "github",
			owner: "odin",
			repo: "odin",
			number: 42,
			issue: false,
		});
	});

	test("an issue link is not a PR link", () => {
		expect(
			githubRef(item({ url: "https://github.com/a/b/issues/7" }))?.issue,
		).toBe(true);
	});

	test("a ticket key in the title", () => {
		expect(jiraRef(item({ title: "Chase BUGT-1234 before Friday" }))).toBe(
			"BUGT-1234",
		);
	});
});

describe("verdicts", () => {
	// The strongest signal there is, and it costs no call: the reaction that
	// queued the row is gone from the message.
	test("a Slack row whose :eyes: was taken off is done", async () => {
		const answer = await sweepItem(
			item({ key: "slack:C1:123", unreacted: true }),
			deps(),
		);
		expect(answer.verdict).toBe("DROP");
	});

	test("a merged PR drops, an open one stays", async () => {
		const linked = item({ url: "https://github.com/odin/odin/pull/42" });
		expect(
			(
				await sweepItem(
					linked,
					deps({
						githubState: async () => ({ state: "closed", merged: true }),
					}),
				)
			).verdict,
		).toBe("DROP");
		expect(
			(
				await sweepItem(
					linked,
					deps({ githubState: async () => ({ state: "open", merged: false }) }),
				)
			).verdict,
		).toBe("KEEP");
	});

	test("a Done ticket drops, and says which status it read", async () => {
		const answer = await sweepItem(
			item({ title: "Chase BUGT-1234" }),
			deps({ jiraStatus: async () => ({ name: "Won't Do", done: true }) }),
		);
		expect(answer).toEqual({
			verdict: "DROP",
			evidence: "BUGT-1234 is Won't Do",
		});
	});

	test("an open ticket stays", async () => {
		expect(
			(
				await sweepItem(
					item({ title: "Chase BUGT-1234" }),
					deps({
						jiraStatus: async () => ({ name: "In Review", done: false }),
					}),
				)
			).verdict,
		).toBe("KEEP");
	});

	// "UTF-8" and "GPT-4" are key-shaped. Jira answers "no such issue", and the
	// item must fall through to whatever else it has rather than stopping there.
	test("a key-shaped word Jira doesn't know falls through to the thread", async () => {
		const answer = await sweepItem(
			item({ key: "slack:C1:123", title: "the UTF-8 export is broken" }),
			deps({
				slackThread: async () => ({
					replies: 2,
					answeredByMe: true,
					lastAuthor: "me",
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "DROP",
			evidence: "you replied in the thread",
		});
	});

	test("replies from other people are context, not a reason to clear", async () => {
		const answer = await sweepItem(
			item({ key: "slack:C1:123" }),
			deps({
				slackThread: async () => ({
					replies: 3,
					answeredByMe: false,
					lastAuthor: "Tamir",
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "KEEP",
			evidence: "3 replies, last from Tamir",
		});
	});

	// Everything the sweep could not read has to land here. A DROP deletes.
	test("nothing reachable is never a DROP", async () => {
		const unreachable = [
			item({ url: "https://github.com/odin/odin/pull/42" }),
			item({ title: "Chase BUGT-1234" }),
			item({ key: "slack:C1:123" }),
			item({ title: "write the thing" }),
		];
		for (const row of unreachable)
			expect((await sweepItem(row, deps())).verdict).toBe("UNKNOWN");
	});
});
