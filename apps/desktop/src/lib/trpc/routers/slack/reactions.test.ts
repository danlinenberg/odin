import { describe, expect, test } from "bun:test";
import {
	buildPermalink,
	channelLabel,
	isGreeting,
	mentionedUserIds,
	messageBody,
	normalizeReaction,
	pickEyedMessages,
	pickSavedMessages,
	reactionStatus,
	replaceMentions,
	rowsToVerify,
	type SlackReactionsListItem,
	savedRowsToClose,
	slackTextToPlain,
	threadParentTs,
	toEyedMessage,
	toTitle,
	untilNextQueued,
} from "./reactions";

const ME = "U_ME";

function item(
	partial: Partial<SlackReactionsListItem["message"]> & { ts: string },
	reactions: { name: string; users: string[] }[],
	channel = "C1",
): SlackReactionsListItem {
	return {
		type: "message",
		channel,
		message: { text: "hi", ...partial, reactions },
	};
}

describe("pickEyedMessages", () => {
	test("keeps only messages I put an :eyes: on", () => {
		const items = [
			item({ ts: "100.1" }, [{ name: "eyes", users: [ME] }]),
			// someone else's eyes
			item({ ts: "100.2" }, [{ name: "eyes", users: ["U_OTHER"] }]),
			// my reaction, wrong emoji
			item({ ts: "100.3" }, [{ name: "thumbsup", users: [ME] }]),
		];
		expect(pickEyedMessages(items, ME).map((m) => m.messageTs)).toEqual([
			"100.1",
		]);
	});

	test("follows the configured reaction instead of :eyes:", () => {
		const items = [
			item({ ts: "100.1" }, [{ name: "eyes", users: [ME] }]),
			item({ ts: "100.2" }, [{ name: "thumbsup", users: [ME] }]),
		];
		expect(
			pickEyedMessages(items, ME, "thumbsup").map((m) => m.messageTs),
		).toEqual(["100.2"]);
	});

	test("my launch reaction queues the message and flags it to start", () => {
		const items = [
			item({ ts: "100.1" }, [{ name: "eyes", users: [ME] }]),
			item({ ts: "100.2" }, [{ name: "robot_face", users: [ME] }]),
			item({ ts: "100.3" }, [{ name: "robot_face", users: ["U_OTHER"] }]),
		];
		expect(
			pickEyedMessages(items, ME).map((m) => [m.messageTs, m.launch]),
		).toEqual([
			["100.1", false],
			["100.2", true],
		]);
	});

	test("keys a row by channel + ts, and carries the thread parent", () => {
		const [row] = pickEyedMessages(
			[
				item({ ts: "200.5", thread_ts: "199.0", user: "U_AUTHOR" }, [
					{ name: "eyes", users: ["U_OTHER", ME] },
				]),
			],
			ME,
		);
		expect(row.id).toBe("C1:200.5");
		expect(row.threadTs).toBe("199.0");
		expect(row.authorId).toBe("U_AUTHOR");
	});

	test("skips non-message items and malformed entries", () => {
		const items: SlackReactionsListItem[] = [
			{ type: "file", channel: "C1", message: { ts: "1.0" } },
			{ type: "message", message: { ts: "1.0" } }, // no channel
			{ type: "message", channel: "C1" }, // no message
		];
		expect(pickEyedMessages(items, ME)).toEqual([]);
	});
});

describe("threadParentTs", () => {
	// The case that made a 37-reply thread read as empty: the row points at a
	// reply, and every thread fact lives on the parent.
	test("a reply asks about its parent", () => {
		expect(threadParentTs({ ts: "200.1", thread_ts: "100.1" })).toBe("100.1");
	});

	test("a thread parent asks about itself", () => {
		expect(threadParentTs({ ts: "100.1", thread_ts: "100.1" })).toBeNull();
	});

	test("a message in no thread asks about itself", () => {
		expect(threadParentTs({ ts: "100.1" })).toBeNull();
	});
});

describe("rowsToVerify", () => {
	const row = (
		id: string,
		lastSeenAt: number,
		doneAt: number | null = null,
	) => ({
		id,
		lastSeenAt,
		doneAt,
	});

	test("asks about the rows the page didn't show, oldest sighting first", () => {
		const rows = [row("a", 30), row("b", 10), row("c", 20)];
		expect(rowsToVerify(rows, new Set(["a"]), 8).map((r) => r.id)).toEqual([
			"b",
			"c",
		]);
	});

	test("a row still on the page is already answered", () => {
		expect(rowsToVerify([row("a", 1)], new Set(["a"]), 8)).toEqual([]);
	});

	test("done rows don't spend the budget", () => {
		const rows = [row("done", 1, 5), row("open", 2)];
		expect(rowsToVerify(rows, new Set(), 8).map((r) => r.id)).toEqual(["open"]);
	});

	test("the budget caps one sync, and the rest rotate in on the next", () => {
		const rows = [row("a", 1), row("b", 2), row("c", 3)];
		expect(rowsToVerify(rows, new Set(), 2).map((r) => r.id)).toEqual([
			"a",
			"b",
		]);
	});
});

describe("pickSavedMessages", () => {
	const saved = (partial: Record<string, unknown> = {}) => ({
		item_id: "C1",
		item_type: "message",
		ts: "100.1",
		state: "in_progress",
		todo_state: "saved",
		...partial,
	});

	test("an open saved message is a queue item", () => {
		expect(pickSavedMessages([saved()])).toEqual([
			{ id: "C1:100.1", channelId: "C1", messageTs: "100.1" },
		]);
	});

	test("saved files and channels are not", () => {
		const items = [
			saved({ item_type: "file", item_id: "F1" }),
			saved({ item_type: "channel" }),
		];
		expect(pickSavedMessages(items)).toEqual([]);
	});

	test("completed and archived items are not", () => {
		const items = [
			saved({ ts: "1.1", state: "completed" }),
			saved({ ts: "1.2", todo_state: "completed" }),
			saved({ ts: "1.3", is_archived: true }),
			saved({ ts: "1.4", date_completed: 1790000000 }),
			saved({ ts: "1.5", date_completed: 0, is_archived: false }),
		];
		expect(pickSavedMessages(items).map((m) => m.messageTs)).toEqual(["1.5"]);
	});

	test("anything not shaped like a saved message is skipped, not trusted", () => {
		const items = [
			null,
			"C1:100.1",
			saved({ item_id: 42 }),
			saved({ ts: undefined }),
			saved({ item_id: "" }),
			saved({ ts: "100.2", extra: { nested: true } }),
		];
		expect(pickSavedMessages(items).map((m) => m.id)).toEqual(["C1:100.2"]);
	});

	test("the same message twice is one item", () => {
		expect(pickSavedMessages([saved(), saved()])).toHaveLength(1);
	});
});

describe("toEyedMessage", () => {
	test("builds the same row a reaction would, never launching", () => {
		expect(
			toEyedMessage(
				"C1",
				"200.1",
				{
					user: "U_AUTHOR",
					text: "<@U1|dan> can you look?",
					thread_ts: "100.1",
					permalink: "https://x.slack.com/archives/C1/p2001",
				},
				false,
			),
		).toEqual({
			id: "C1:200.1",
			channelId: "C1",
			messageTs: "200.1",
			threadTs: "100.1",
			authorId: "U_AUTHOR",
			text: "@dan can you look?",
			permalink: "https://x.slack.com/archives/C1/p2001",
			launch: false,
		});
	});
});

describe("savedRowsToClose", () => {
	const row = (
		id: string,
		source: "reaction" | "saved" = "saved",
		extra: { unreactedAt?: number | null; doneAt?: number | null } = {},
	) => ({ id, source, unreactedAt: null, doneAt: null, ...extra });

	test("a saved row gone from the Later list closes", () => {
		const rows = [row("kept"), row("gone")];
		expect(
			savedRowsToClose(rows, new Set(["kept"]), new Set()).map((r) => r.id),
		).toEqual(["gone"]);
	});

	test(":eyes: rows are the reaction sweep's, not this one's", () => {
		expect(
			savedRowsToClose([row("a", "reaction")], new Set(), new Set()),
		).toEqual([]);
	});

	test("a saved row I :eyes:'d this sync stays open", () => {
		expect(savedRowsToClose([row("a")], new Set(), new Set(["a"]))).toEqual([]);
	});

	test("rows already closed or done are left alone", () => {
		const rows = [
			row("closed", "saved", { unreactedAt: 5 }),
			row("done", "saved", { doneAt: 5 }),
		];
		expect(savedRowsToClose(rows, new Set(), new Set())).toEqual([]);
	});
});

describe("slackTextToPlain", () => {
	test("renders links, mentions and entities", () => {
		expect(slackTextToPlain("see <https://x.dev|the docs>")).toBe(
			"see the docs (https://x.dev)",
		);
		expect(slackTextToPlain("<https://x.dev|https://x.dev>")).toBe(
			"https://x.dev",
		);
		expect(slackTextToPlain("see <https://x.dev>")).toBe("see https://x.dev");
		expect(slackTextToPlain("<@U123|dan> ping <@U456>")).toBe(
			"@dan ping @U456",
		);
		expect(slackTextToPlain("in <#C1|general>")).toBe("in #general");
		expect(slackTextToPlain("<!here> a &amp; b")).toBe("@here a & b");
	});
});

describe("mentions", () => {
	test("ids become names, unknown ids stay put", () => {
		const text = "@U08EJ28KM0V ping @U040V0M09C6 @here";
		expect(mentionedUserIds(text)).toEqual(["U08EJ28KM0V", "U040V0M09C6"]);
		expect(
			replaceMentions(text, new Map([["U08EJ28KM0V", "Tamir Davidov"]])),
		).toBe("@Tamir Davidov ping @U040V0M09C6 @here");
	});
});

describe("toTitle", () => {
	test("first non-empty line, capped", () => {
		expect(toTitle("\n\n  real title \nmore")).toBe("real title");
		expect(toTitle("   ")).toBe("(no text)");
		expect(toTitle("x".repeat(200))).toHaveLength(121); // 120 + ellipsis
	});

	test("skips an opening line that is only hello", () => {
		expect(toTitle("Hi good morning :sunny:\n\nThe export is stuck")).toBe(
			"The export is stuck",
		);
		expect(toTitle("Hi Dan.\ncan you look at BUGT-1?")).toBe(
			"can you look at BUGT-1?",
		);
		// A mention followed by the ask is the ask - don't skip the line.
		expect(toTitle("@Dan Linenberg can you help? :pray:")).toBe(
			"@Dan Linenberg can you help? :pray:",
		);
		// Nothing but hello: better a greeting than "(no text)".
		expect(toTitle("Hi good morning :sunny:")).toBe("Hi good morning :sunny:");
	});
});

describe("isGreeting", () => {
	test("hello, and nothing else", () => {
		expect(isGreeting("Hi good morning :sunny:")).toBe(true);
		expect(isGreeting("Hey @Dan Linenberg 👀")).toBe(true);
		expect(isGreeting("boker tov!")).toBe(true);
		expect(isGreeting("Hi, the HDR merge is failing")).toBe(false);
		expect(isGreeting("Morning - from Ladis, can you check?")).toBe(false);
	});
});

describe("buildPermalink", () => {
	test("channel message", () => {
		expect(
			buildPermalink({
				teamUrl: "https://imagen.slack.com/",
				channelId: "C1",
				messageTs: "1700000000.123456",
				threadTs: null,
			}),
		).toBe("https://imagen.slack.com/archives/C1/p1700000000123456");
	});

	test("thread reply carries the parent, so the link opens the thread", () => {
		expect(
			buildPermalink({
				teamUrl: "https://imagen.slack.com",
				channelId: "C1",
				messageTs: "1700000001.000200",
				threadTs: "1700000000.123456",
			}),
		).toBe(
			"https://imagen.slack.com/archives/C1/p1700000001000200?thread_ts=1700000000.123456&cid=C1",
		);
	});
});

describe("reactionStatus", () => {
	test("Done wins over a started session", () => {
		expect(reactionStatus({ startedAt: 1, doneAt: 2 })).toBe("Done");
		expect(reactionStatus({ startedAt: null, doneAt: 2 })).toBe("Done");
	});

	test("a launched session reads as in progress, and keeps reading that way", () => {
		// startedAt persists, so this holds after the pane is gone and the app
		// has restarted - the whole reason it isn't inferred from live panes.
		expect(reactionStatus({ startedAt: 1, doneAt: null })).toBe("In progress");
	});

	test("untouched rows are not started", () => {
		expect(reactionStatus({ startedAt: null, doneAt: null })).toBe(
			"Not started",
		);
	});
});

describe("normalizeReaction", () => {
	test("strips colons and case, and falls back to :eyes:", () => {
		expect(normalizeReaction(":White_Check_Mark:")).toBe("white_check_mark");
		expect(normalizeReaction("  eyes ")).toBe("eyes");
		expect(normalizeReaction("::")).toBe("eyes");
		expect(normalizeReaction("")).toBe("eyes");
	});
});

describe("channelLabel", () => {
	test("channels get a #, group DMs get their members", () => {
		expect(channelLabel("eng")).toBe("#eng");
		expect(channelLabel("mpdm-dan.l--netanel--shahar-1")).toBe(
			"dan.l, netanel, shahar",
		);
		// A 1:1 DM has no name at all.
		expect(channelLabel(null)).toBe(null);
	});
});

describe("messageBody", () => {
	test("falls back to attachments when a bot leaves text empty", () => {
		expect(
			messageBody({
				text: "",
				attachments: [
					{
						title: "[Triggered] DB CPU high",
						text: "cpu > 90%",
						fallback: "x",
					},
					{ fallback: "only fallback" },
				],
			}),
		).toBe("[Triggered] DB CPU high\ncpu > 90%\n\nonly fallback");
		expect(messageBody({ text: "hi", attachments: [{ title: "t" }] })).toBe(
			"hi",
		);
	});
});

describe("untilNextQueued", () => {
	const queue = new Set(["eyes", "robot_face"]);
	// Two tasks queued in a DM to myself: the first must not read the second.
	test("stops at the next message I queued", () => {
		const kept = untilNextQueued(
			[
				{ ts: "300.1", reactions: [{ name: "robot_face", users: [ME] }] },
				{ ts: "100.1", reactions: [{ name: "robot_face", users: [ME] }] },
				{ ts: "200.1", reactions: [{ name: "eyes", users: ["U_OTHER"] }] },
			],
			"100.1",
			ME,
			queue,
		);
		expect(kept.map((m) => m.ts)).toEqual(["100.1", "200.1"]);
	});
});
