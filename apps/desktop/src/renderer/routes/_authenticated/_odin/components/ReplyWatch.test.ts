import { expect, test } from "bun:test";
import { newReplies, sessionThread } from "./ReplyWatch";

const reply = (stamp: string, byMe = false) => ({ stamp, byMe, text: null });

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
