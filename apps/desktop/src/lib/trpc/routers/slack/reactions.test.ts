import { describe, expect, test } from "bun:test";
import {
	buildPermalink,
	isGreeting,
	mentionedUserIds,
	normalizeReaction,
	oldestExaminedTs,
	pickEyedMessages,
	reactionStatus,
	replaceMentions,
	type SlackReactionsListItem,
	slackTextToPlain,
	toTitle,
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

describe("oldestExaminedTs", () => {
	test("compares numerically, not lexically", () => {
		// "999999999.1" sorts above "1000000000.1" as a string.
		const items = [
			item({ ts: "1000000000.1" }, []),
			item({ ts: "999999999.1" }, []),
		];
		expect(oldestExaminedTs(items)).toBe("999999999.1");
	});

	test("null when nothing was examined", () => {
		expect(oldestExaminedTs([])).toBeNull();
	});
});

describe("slackTextToPlain", () => {
	test("renders links, mentions and entities", () => {
		expect(slackTextToPlain("see <https://x.dev|the docs>")).toBe(
			"see the docs",
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
		// A mention followed by the ask is the ask — don't skip the line.
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
		expect(isGreeting("Morning — from Ladis, can you check?")).toBe(false);
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
		// has restarted — the whole reason it isn't inferred from live panes.
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
