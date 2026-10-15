import { expect, test } from "bun:test";
import { newReplies, sessionThread, useReplyWatch } from "./ReplyWatch";

const reply = (stamp: string, byMe = false) => ({
	stamp,
	byMe,
	text: null,
	url: null,
});

test("pings only on a new reply from someone else, after the first check", () => {
	const watches = {
		"slack:a": { title: "a", paneId: "p" }, // never checked: baseline only
		"slack:b": { title: "b", paneId: "p", stamp: "1" }, // new reply
		"slack:c": { title: "c", paneId: "p", stamp: "1" }, // nothing new
		"jira:D-1": { title: "d", paneId: "p", stamp: "" }, // first reply ever
		"jira:E-1": { title: "e", paneId: "p", stamp: "1" }, // my own reply
	};
	expect(
		newReplies(watches, {
			"slack:a": reply("5"),
			"slack:b": reply("2"),
			"slack:c": reply("1"),
			"jira:D-1": reply("x"),
			"jira:E-1": reply("2", true),
		}).sort(),
	).toEqual(["jira:D-1", "slack:b"]);
});

test("finds the thread a session is about", () => {
	expect(sessionThread({ odinPageId: "C1:1790165128.883119" })).toBe(
		"slack:C1:1790165128.883119",
	);
	expect(
		sessionThread({
			brief:
				"see https://x.slack.com/archives/C0B8/p1790171273871159?thread_ts=1",
		}),
	).toBe("slack:C0B8:1790171273.871159");
	expect(sessionThread({ odinTaskTitle: "CRR-947: Refund" })).toBe(
		"jira:CRR-947",
	);
	expect(
		sessionThread({ odinBrief: "https://a.atlassian.net/browse/BUGT-12 x" }),
	).toBe("jira:BUGT-12");
	expect(sessionThread({ odinTaskTitle: "Fix UTF-8 parsing" })).toBeNull();
});

test("a session with no task fields finds the thread its panel shows", () => {
	expect(
		sessionThread({
			links: [
				null,
				"https://x.slack.com/archives/C03E/p1788333752934919?thread_ts=1787569128.041959&cid=C03E",
			],
		}),
	).toBe("slack:C03E:1787569128.041959");
});

test("a new reply stays on the card until the session is opened", () => {
	const { toggle, setStamps, seen } = useReplyWatch.getState();
	toggle("slack:C1:1.1", "t", "pane-1");
	setStamps(
		{ "slack:C1:1.1": "2.2" },
		{ "slack:C1:1.1": "Sounds good" },
		{ "slack:C1:1.1": "https://x.slack.com/archives/C1/p1000001" },
	);
	setStamps({ "slack:C1:1.1": "2.2" });
	const watch = useReplyWatch.getState().watches["slack:C1:1.1"];
	expect(watch?.reply).toBe("Sounds good");
	// Kept for Open once the session is closed.
	expect(watch?.url).toBe("https://x.slack.com/archives/C1/p1000001");
	seen("pane-1");
	expect(
		useReplyWatch.getState().watches["slack:C1:1.1"]?.reply,
	).toBeUndefined();
});
