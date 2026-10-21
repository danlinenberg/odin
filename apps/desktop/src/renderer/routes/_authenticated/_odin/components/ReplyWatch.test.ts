import { expect, test } from "bun:test";
import {
	conditionOutcome,
	conditionPrompt,
	newReplies,
	sessionThread,
	startedWorking,
	useReplyWatch,
	watchEvent,
} from "./ReplyWatch";

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
		"pr:u1": { title: "f", paneId: "p" }, // approved before the first check
		"pr:u2": { title: "g", paneId: "p" }, // not approved yet
	};
	expect(
		newReplies(watches, {
			"slack:a": reply("5"),
			"slack:b": reply("2"),
			"slack:c": reply("1"),
			"jira:D-1": reply("x"),
			"jira:E-1": reply("2", true),
			"pr:u1": reply("approved"),
			"pr:u2": reply("", true),
		}).sort(),
	).toEqual(["jira:D-1", "pr:u1", "slack:b"]);
});

test("one toggle watches a session's thread and PR, the next stops both", () => {
	const { toggle } = useReplyWatch.getState();
	const pr = "pr:https://github.com/o/r/pull/1";
	toggle(["jira:A-1", pr], "t", "pane-2");
	expect(useReplyWatch.getState().watches[pr]?.paneId).toBe("pane-2");
	expect(watchEvent(pr)).toBe("Approved");
	expect(watchEvent("jira:A-1")).toBe("New reply");
	toggle([], "", "pane-2");
	expect(
		Object.values(useReplyWatch.getState().watches).some(
			(w) => w.paneId === "pane-2",
		),
	).toBe(false);
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
	toggle(["slack:C1:1.1"], "t", "pane-1");
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

// The bell keeps jiggling until you write in the session, not until you look.
test("a session turning to Working answers its reply; staying Working does not", () => {
	expect(
		startedWorking(
			{
				a: { status: "review" },
				b: { status: "working" },
				c: { status: "idle" },
			},
			{
				a: { status: "working" },
				b: { status: "working" },
				c: { status: "review" },
			},
		),
	).toEqual(["a"]);
});

const said = (
	text: string,
	at = "2026-10-21T10:05:00Z",
	role: "user" | "assistant" = "assistant",
) => ({ role, text, at });
const SINCE = Date.parse("2026-10-21T10:00:00Z");

test("a condition happened when Claude says so on a line of its own", () => {
	expect(
		conditionOutcome(
			[
				said("Checking the deploy now."),
				said(
					"Deploy finished.\n**ODIN PING: HAPPENED** - app-web-server is live",
				),
			],
			SINCE,
		),
	).toEqual({ event: "Happened", detail: "app-web-server is live" });
	expect(
		conditionOutcome(
			[said("ODIN PING: GAVE UP - no access to Datadog")],
			SINCE,
		),
	).toEqual({ event: "Gave up", detail: "no access to Datadog" });
});

test("a condition is not met by the prompt, an old line or a promise", () => {
	const prompt = conditionPrompt("the deploy is done");
	expect(prompt).toContain("the deploy is done");
	expect(prompt).toContain("ODIN PING: HAPPENED");
	expect(
		conditionOutcome(
			[
				said(prompt, "2026-10-21T10:01:00Z", "user"),
				said(
					"ODIN PING: HAPPENED - from an earlier watch",
					"2026-10-21T09:00:00Z",
				),
				said(
					"I will reply `ODIN PING: HAPPENED - <what I saw>` when it lands.",
				),
				said("ODIN PING: HAPPENED - <what you saw>"),
				said("Still deploying, next check in 5 minutes."),
			],
			SINCE,
		),
	).toBeNull();
});

test("Ping me when... keeps the session's other watches and fires once", () => {
	const s = () => useReplyWatch.getState();
	s().toggle(["jira:W-1"], "Deploy", "pane-w");
	s().watchFor("the deploy is done", "Deploy", "pane-w");
	const key = Object.keys(s().watches).find((k) => k.startsWith("when:"));
	expect(key).toBeDefined();
	expect(s().watches["jira:W-1"]?.paneId).toBe("pane-w");
	expect(watchEvent(key ?? "", s().watches[key ?? ""])).toBe("Happened");
	s().fire(key ?? "", "Happened");
	expect(s().watches[key ?? ""]?.reply).toBe("the deploy is done");
	expect(s().watches[key ?? ""]?.stamp).toBe("fired");
	// Writing in the session reads it, and a condition that fired is done.
	s().seen("pane-w");
	expect(s().watches[key ?? ""]).toBeUndefined();
	expect(s().watches["jira:W-1"]?.paneId).toBe("pane-w");
	s().toggle([], "", "pane-w");
});

test("a condition Claude gave up on says so", () => {
	const s = () => useReplyWatch.getState();
	s().watchFor("the edit is done", "Edit", "pane-g");
	const key = Object.keys(s().watches).find(
		(k) => s().watches[k]?.paneId === "pane-g",
	);
	s().fire(key ?? "", "Gave up");
	expect(watchEvent(key ?? "", s().watches[key ?? ""])).toBe("Gave up");
	s().toggle([], "", "pane-g");
});

test("a PR approved before its first check pings once, then not again", () => {
	const pr = "pr:https://github.com/o/r/pull/12";
	const { toggle, add } = useReplyWatch.getState();
	toggle(["jira:A-2"], "t", "pane-12");
	// A PR the session made after Ping me was on joins with no stamp.
	add([pr], "pane-12");
	expect(useReplyWatch.getState().watches[pr]?.stamp).toBeUndefined();
	const activity = { [pr]: reply("approved") };
	expect(newReplies(useReplyWatch.getState().watches, activity)).toEqual([pr]);
	useReplyWatch.getState().setStamps({ [pr]: "approved" });
	expect(newReplies(useReplyWatch.getState().watches, activity)).toEqual([]);
	toggle([], "", "pane-12");
});
