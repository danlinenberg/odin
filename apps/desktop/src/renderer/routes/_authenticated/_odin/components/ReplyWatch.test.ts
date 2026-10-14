import { expect, test } from "bun:test";
import { newReplies } from "./ReplyWatch";

const reply = (stamp: string, byMe = false) => ({ stamp, byMe, text: null });

test("pings only on a new reply from someone else, after the first check", () => {
	const watches = {
		"slack:a": { title: "a", url: null }, // never checked: baseline only
		"slack:b": { title: "b", url: null, stamp: "1" }, // new reply
		"slack:c": { title: "c", url: null, stamp: "1" }, // nothing new
		"jira:D-1": { title: "d", url: null, stamp: "" }, // first reply ever
		"jira:E-1": { title: "e", url: null, stamp: "1" }, // my own reply
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
