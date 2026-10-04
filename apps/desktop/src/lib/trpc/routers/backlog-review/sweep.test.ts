import { describe, expect, test } from "bun:test";
import {
	approverOf,
	duplicates,
	githubRef,
	jiraMovedAt,
	jiraOwnership,
	jiraRef,
	mapLimit,
	PROMISE,
	type SweepDeps,
	type SweepItem,
	sweepItem,
} from "./sweep";

const DAY = 86_400_000;

/** A Slack ts from yesterday - "this thread is alive". */
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

	test("a review request someone else approved drops", async () => {
		const answer = await sweepItem(
			item({ url: "https://github.com/odin/odin/pull/42" }),
			deps({
				githubState: async () => ({
					state: "open",
					merged: false,
					approvedBy: "alice",
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "DROP",
			evidence: "odin/odin#42 is already approved by alice",
		});
	});

	test("an approval counts only while it is someone else's latest word", () => {
		const r = (login: string, state: string) => ({ state, user: { login } });
		expect(
			approverOf([r("alice", "APPROVED"), r("alice", "COMMENTED")], "me"),
		).toBe("alice");
		expect(
			approverOf(
				[r("alice", "APPROVED"), r("alice", "CHANGES_REQUESTED")],
				"me",
			),
		).toBeNull();
		expect(
			approverOf([r("alice", "APPROVED"), r("alice", "DISMISSED")], "me"),
		).toBeNull();
		expect(approverOf([r("Me", "APPROVED")], "me")).toBeNull();
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
					lastReplyTs: recentTs(),
					channelLastTs: null,
					channelLastByMe: false,
					isDirect: false,
				}),
			}),
		);
		// Replying is not finishing: kept, and only age can retire it.
		expect(answer.verdict).toBe("KEEP");
	});

	// Reported from the board: "@Idan @Dan will need your help here", and Idan
	// answered all seven points. The ask was never waiting on me after that.
	test("someone tagged with me answering the ask is a DROP", async () => {
		const answer = await sweepItem(
			item({ key: "slack:C1:123", title: "@Idan @Dan will need your help" }),
			deps({
				slackThread: async () => ({
					replies: 5,
					lastReplyByMe: false,
					iReplied: false,
					repliersComplete: true,
					lastReplyTs: recentTs(),
					channelLastTs: null,
					channelLastByMe: false,
					isDirect: false,
					answeredBy: "Idan Dagan",
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "DROP",
			evidence: "Idan Dagan, tagged with you, answered in the thread",
		});
	});

	// Reported from the board: a thread Dan answered in week one, where they
	// came back in week three asking him to decide. In reply_users, not the last
	// word - the row is still his.
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
					channelLastTs: null,
					channelLastByMe: false,
					isDirect: false,
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "KEEP",
			evidence: "2 replies, and they answered after you",
		});
	});

	// Reported from the board: a group DM where the answer was typed into the
	// DM, not into a thread. The thread rungs see nothing and the row reads as
	// 22 days dead.
	// Replying isn't finishing - "on it" is an answer too. The DM reply keeps
	// the row alive rather than clearing it.
	test("replying in the DM is not finishing it", async () => {
		const answer = await sweepItem(
			item({ key: "slack:D1:123" }),
			deps({
				slackThread: async () => ({
					replies: 0,
					lastReplyByMe: false,
					iReplied: false,
					repliersComplete: true,
					lastReplyTs: null,
					channelLastTs: recentTs(),
					channelLastByMe: true,
					isDirect: true,
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "KEEP",
			evidence: "you replied last in the DM",
		});
	});

	// "Nevermind, I have it now" 👍: their last word, and I acknowledged it.
	test("reacting to their last DM message drops it; not reacting doesn't", async () => {
		const dm = (acked: boolean) =>
			deps({
				slackThread: async () => ({
					replies: 0,
					lastReplyByMe: false,
					iReplied: false,
					repliersComplete: true,
					lastReplyTs: null,
					channelLastTs: recentTs(),
					channelLastByMe: false,
					channelLastAckedByMe: acked,
					isDirect: true,
				}),
			});
		expect(await sweepItem(item({ key: "slack:D1:123" }), dm(true))).toEqual({
			verdict: "DROP",
			evidence: "you reacted to their last message in the DM",
		});
		expect(await sweepItem(item({ key: "slack:D1:123" }), dm(false))).toEqual({
			verdict: "KEEP",
			evidence: "they wrote last in the DM",
		});
	});

	// The same signal in a channel is me saying something unrelated later.
	test("speaking later in a CHANNEL is not answering", async () => {
		const answer = await sweepItem(
			item({ key: `slack:C1:${((Date.now() - 3 * DAY) / 1000).toFixed(6)}` }),
			deps({
				slackThread: async () => ({
					replies: 0,
					lastReplyByMe: false,
					iReplied: false,
					repliersComplete: true,
					lastReplyTs: null,
					channelLastTs: recentTs(),
					channelLastByMe: true,
					isDirect: false,
				}),
			}),
		);
		// Kept, and kept alive: the channel moved, so it isn't stale either.
		expect(answer).toEqual({ verdict: "KEEP", evidence: "nobody has replied" });
	});

	// A channel you read every morning has "activity" every morning. If that
	// counted, no row in any live channel could ever go stale.
	test("a busy channel doesn't keep an old row alive", async () => {
		const answer = await sweepItem(
			item({ key: `slack:C1:${((Date.now() - 60 * DAY) / 1000).toFixed(6)}` }),
			deps({
				slackThread: async () => ({
					replies: 0,
					lastReplyByMe: false,
					iReplied: false,
					repliersComplete: true,
					lastReplyTs: null,
					channelLastTs: recentTs(),
					channelLastByMe: false,
					isDirect: false,
				}),
			}),
		);
		expect(answer.verdict).toBe("DROP");
		expect(answer.evidence).toContain("nothing has moved in 60 days");
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
					channelLastTs: null,
					channelLastByMe: false,
					isDirect: false,
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
					channelLastTs: null,
					channelLastByMe: false,
					isDirect: false,
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
	// there is, so it counts - this is a checked row, not an unreadable one.
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

	// The feed's `updated` says two days ago, but that was a sprint carry-over.
	test("a ticket only carried across sprints goes stale", async () => {
		const answer = await sweepItem(
			item({ title: "BUGT-1234", lastActivityAt: Date.now() - 2 * DAY }),
			deps({
				jiraStatus: async () => ({
					name: "New",
					done: false,
					movedAt: Date.now() - 400 * DAY,
				}),
			}),
		);
		expect(answer).toEqual({
			verdict: "DROP",
			evidence: "BUGT-1234 is New, and nothing has moved in 400 days",
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
					channelLastTs: null,
					channelLastByMe: false,
					isDirect: false,
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
					channelLastTs: null,
					channelLastByMe: false,
					isDirect: false,
				}),
			}),
		);
		expect(answer.verdict).toBe("DROP");
		expect(answer.evidence).toContain("nobody has replied");
	});
});

describe("mapLimit", () => {
	test("keeps order and never exceeds the limit", async () => {
		let inFlight = 0;
		let peak = 0;
		const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
			peak = Math.max(peak, ++inFlight);
			await new Promise((resolve) => setTimeout(resolve, n));
			inFlight--;
			return n * 10;
		});
		expect(out).toEqual([50, 10, 40, 20, 30, 0]);
		expect(peak).toBe(2);
	});
});

describe("jiraMovedAt", () => {
	const at = (iso: string) => Date.parse(iso);
	const history = (created: string, ...fields: string[]) => ({
		created,
		items: fields.map((field) => ({ field })),
	});

	test("skips sprint carry-overs, counts comments and real changes", () => {
		expect(
			jiraMovedAt({
				fields: {
					created: "2025-01-01T00:00:00Z",
					comment: {
						total: 1,
						comments: [{ created: "2025-03-01T00:00:00Z" }],
					},
				},
				changelog: {
					total: 3,
					histories: [
						history("2026-09-22T00:00:00Z", "Sprint"),
						history("2026-09-01T00:00:00Z", "Rank"),
						history("2025-02-01T00:00:00Z", "status"),
					],
				},
			}),
		).toBe(at("2025-03-01T00:00:00Z"));
	});

	test("a cut-short changelog can't be trusted", () => {
		expect(
			jiraMovedAt({
				fields: { created: "2025-01-01T00:00:00Z" },
				changelog: {
					total: 200,
					histories: [history("2025-02-01T00:00:00Z", "status")],
				},
			}),
		).toBeNull();
	});
});

describe("rows the source already answered", () => {
	test("a Notion row marked Done drops", async () => {
		expect(
			await sweepItem(
				item({ key: "notion:p1", source: "Notion", status: "Done" }),
				deps(),
			),
		).toEqual({ verdict: "DROP", evidence: "it's marked Done in Notion" });
	});

	test("a Notion row Not started is judged as usual", async () => {
		const answer = await sweepItem(
			item({ key: "notion:p1", source: "Notion", status: "Not started" }),
			deps(),
		);
		expect(answer.verdict).toBe("KEEP");
	});

	test("an automated email drops; a colleague's doesn't", async () => {
		expect(
			(await sweepItem(item({ sender: "Imagen <info@imagen-ai.com>" }), deps()))
				.verdict,
		).toBe("DROP");
		expect(
			(
				await sweepItem(
					item({ sender: "Nir Bitan <nir.b@imagen-ai.com>" }),
					deps(),
				)
			).verdict,
		).toBe("KEEP");
	});

	test("an inbox copy of a queued Slack message is a duplicate", () => {
		const copies = duplicates([
			item({ key: "slack:C1:1790789194.771389" }),
			item({
				key: "notion:p1",
				detail:
					"https://x.slack.com/archives/C1/p1790789194771389?thread_ts=1.2",
			}),
			item({
				key: "notion:p2",
				detail: "https://x.slack.com/archives/C9/p1790789194771389",
			}),
		]);
		expect([...copies.keys()]).toEqual(["notion:p1"]);
	});
});

describe("someone else's to finish", () => {
	const issue = (
		assignee: string,
		newest?: { by: string; mentions?: string },
	) => ({
		fields: {
			assignee: { accountId: assignee, displayName: "Ori" },
			comment: {
				total: newest ? 1 : 0,
				comments: newest
					? [
							{
								author: { accountId: newest.by },
								body: {
									content: [
										{ type: "mention", attrs: { id: newest.mentions } },
									],
								},
							},
						]
					: [],
			},
		},
	});

	test("assigned to someone else, nothing asked of me", () => {
		expect(jiraOwnership(issue("ori"), "me")).toEqual({
			owner: "Ori",
			askedOfMe: false,
		});
		expect(jiraOwnership(issue("me"), "me").owner).toBeNull();
	});

	test("their newest comment @-mentioning me hands it back", () => {
		expect(
			jiraOwnership(issue("ori", { by: "tamir", mentions: "me" }), "me")
				.askedOfMe,
		).toBe(true);
		expect(
			jiraOwnership(issue("ori", { by: "me", mentions: "tamir" }), "me")
				.askedOfMe,
		).toBe(false);
	});

	test("a Jira row that's someone else's drops; a Slack row naming it doesn't", async () => {
		const d = deps({
			jiraStatus: async () => ({
				name: "Open",
				done: false,
				owner: "Ori",
				askedOfMe: false,
			}),
		});
		expect(
			await sweepItem(item({ key: "jira:BUGT-1", detail: "BUGT-1" }), d),
		).toEqual({
			verdict: "DROP",
			evidence: "BUGT-1 is Open and assigned to Ori",
		});
		expect(
			(await sweepItem(item({ key: "task:t", title: "look at BUGT-1" }), d))
				.verdict,
		).toBe("KEEP");
	});

	test("a conflicted PR nobody has committed to in weeks drops", async () => {
		const d = deps({
			githubState: async () => ({
				state: "open",
				merged: false,
				conflictedForDays: 34,
			}),
		});
		expect(
			(
				await sweepItem(
					item({ key: "pr:o/r#1", url: "https://github.com/o/r/pull/1" }),
					d,
				)
			).evidence,
		).toBe("o/r#1 has merge conflicts and no commit in 34 days");
	});

	test("a review asked of a team drops on the PR row only", async () => {
		const d = deps({
			githubState: async () => ({
				state: "open",
				merged: false,
				teamOnly: "devops",
			}),
		});
		const url = "https://github.com/o/r/pull/1";
		expect((await sweepItem(item({ key: "pr:o/r#1", url }), d)).verdict).toBe(
			"DROP",
		);
		expect(
			(await sweepItem(item({ key: "slack:D1:1.2", url }), d)).verdict,
		).toBe("KEEP");
	});
});

// A note to myself in the thread is a reminder of work left, not an answer.
test("a note to self is a promise, not an answer", () => {
	expect(PROMISE.test("note to self: remaining photos")).toBe(true);
	expect(PROMISE.test("Fixed, lmk if it works")).toBe(false);
});
