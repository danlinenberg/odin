import { describe, expect, test } from "bun:test";
import {
	githubRef,
	jiraRef,
	type SweepDeps,
	type SweepItem,
	sweepItem,
} from "./sweep";

const DAY = 86_400_000;

/** A Slack ts from yesterday — "this thread is alive". */
const recentTs = () => ((Date.now() - DAY) / 1000).toFixed(6);

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
					lastReplyByMe: true,
					iReplied: true,
					repliersComplete: true,
					lastReplyTs: null,
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "DROP",
			evidence: "you had the last word in the thread",
		});
	});

	// Reported from the board: a thread Dan answered in week one, where they
	// came back in week three asking him to decide. In reply_users, not the last
	// word — the row is still his.
	test("answering earlier is not answering: they replied after you", async () => {
		const answer = await sweepItem(
			item({ key: "slack:C1:123" }),
			deps({
				slackThread: async () => ({
					replies: 2,
					lastReplyByMe: false,
					iReplied: true,
					repliersComplete: true,
					lastReplyTs: recentTs(),
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "KEEP",
			evidence: "2 replies, and they answered after you",
		});
	});

	test("replies from other people are context, not a reason to clear", async () => {
		const answer = await sweepItem(
			item({ key: "slack:C1:123" }),
			deps({
				slackThread: async () => ({
					replies: 3,
					lastReplyByMe: false,
					iReplied: false,
					repliersComplete: true,
					lastReplyTs: recentTs(),
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "KEEP",
			evidence: "3 replies, none from you",
		});
	});

	// Slack caps reply_users at five. Past that, "I'm not in the list" is not
	// evidence I stayed out of the thread, so the evidence must not say so.
	test("a truncated replier list doesn't claim none of them are yours", async () => {
		const answer = await sweepItem(
			item({ key: "slack:C1:123" }),
			deps({
				slackThread: async () => ({
					replies: 9,
					lastReplyByMe: false,
					iReplied: false,
					repliersComplete: false,
					lastReplyTs: recentTs(),
				}),
			}),
		);
		expect(answer).toEqual({ verdict: "KEEP", evidence: "9 replies" });
	});

	// Everything the sweep asked about and got no answer for has to land here.
	// A DROP deletes, and age must never speak over a system that stayed silent.
	test("a source that wouldn't answer is never a DROP, however old", async () => {
		const ancient = { lastActivityAt: Date.now() - 400 * DAY };
		const unreachable = [
			item({ ...ancient, url: "https://github.com/odin/odin/pull/42" }),
			item({ ...ancient, title: "Chase BUGT-1234" }),
			item({ ...ancient, key: "slack:C1:123" }),
		];
		for (const row of unreachable)
			expect((await sweepItem(row, deps())).verdict).toBe("UNKNOWN");
	});

	// A task I typed has no upstream and never will. Silence is the only signal
	// there is, so it counts — this is a checked row, not an unreadable one.
	test("a row with nothing upstream goes stale instead of staying unknown", async () => {
		const fresh = await sweepItem(
			item({ title: "write the thing", lastActivityAt: Date.now() - 3 * DAY }),
			deps(),
		);
		expect(fresh.verdict).toBe("KEEP");

		const old = await sweepItem(
			item({ title: "write the thing", lastActivityAt: Date.now() - 40 * DAY }),
			deps(),
		);
		expect(old.verdict).toBe("DROP");
		expect(old.evidence).toContain("nothing has moved in 40 days");
	});

	test("an open PR nobody has touched in months is rot", async () => {
		const answer = await sweepItem(
			item({
				url: "https://github.com/odin/odin/pull/42",
				lastActivityAt: Date.now() - 60 * DAY,
			}),
			deps({ githubState: async () => ({ state: "open", merged: false }) }),
		);
		expect(answer).toEqual({
			verdict: "DROP",
			evidence: "odin/odin#42 is still open, and nothing has moved in 60 days",
		});
	});

	test("an open ticket that moved this week is kept", async () => {
		const answer = await sweepItem(
			item({ title: "BUGT-1234", lastActivityAt: Date.now() - 2 * DAY }),
			deps({ jiraStatus: async () => ({ name: "In Progress", done: false }) }),
		);
		expect(answer).toEqual({
			verdict: "KEEP",
			evidence: "BUGT-1234 is In Progress",
		});
	});

	// The message is old but the thread answered yesterday: the reply is the
	// freshest thing that happened, so the row is live.
	test("a recent reply keeps an old message alive", async () => {
		const answer = await sweepItem(
			item({ key: `slack:C1:${(Date.now() / 1000 - 90 * 86400).toFixed(6)}` }),
			deps({
				slackThread: async () => ({
					replies: 2,
					lastReplyByMe: false,
					iReplied: false,
					repliersComplete: true,
					lastReplyTs: ((Date.now() - 2 * DAY) / 1000).toFixed(6),
				}),
			}),
		);
		expect(answer.verdict).toBe("KEEP");
	});

	// And the reverse: nobody ever replied, and the message itself is ancient.
	test("an old message nobody ever answered is rot", async () => {
		const answer = await sweepItem(
			item({ key: `slack:C1:${(Date.now() / 1000 - 90 * 86400).toFixed(6)}` }),
			deps({
				slackThread: async () => ({
					replies: 0,
					lastReplyByMe: false,
					iReplied: false,
					repliersComplete: true,
					lastReplyTs: null,
				}),
			}),
		);
		expect(answer.verdict).toBe("DROP");
		expect(answer.evidence).toContain("nobody has replied");
	});
});
