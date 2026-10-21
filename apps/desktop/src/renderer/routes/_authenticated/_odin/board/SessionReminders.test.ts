import { expect, test } from "bun:test";
import { dayOf } from "../components/Reminders";
import {
	newReplies,
	unreadPings,
	useReplyWatch,
} from "../components/ReplyWatch";
import { showsBar, ticketKey } from "./SessionReminders";

test("ticketKey reads the leading Jira key", () => {
	expect(ticketKey("CRR-917: Add DB field for signup endpoint")).toBe(
		"CRR-917",
	);
	expect(ticketKey(" BUGT2-12 fix")).toBe("BUGT2-12");
	expect(ticketKey("Review Renovate updates")).toBeNull();
	expect(ticketKey("Fix CRR-917")).toBeNull();
});

const now = new Date(2026, 9, 20, 12).getTime();
const later = {
	"remind:a": { due: dayOf(now + 2 * 86_400_000), title: "a" },
	"remind:b": { due: dayOf(now + 9 * 86_400_000), title: "b" },
};

test("reminders for a later day alone keep the bar hidden", () => {
	expect(showsBar(later, 0, now)).toBe(false);
});

test("a reminder whose day has come shows the bar", () => {
	const due = { ...later, "remind:c": { due: dayOf(now), title: "c" } };
	expect(showsBar(due, 0, now)).toBe(true);
});

test("an unread reply shows the bar with nothing due", () => {
	expect(showsBar(later, 1, now)).toBe(true);
	expect(showsBar({}, 1, now)).toBe(true);
});

test("a standalone reminder raises the bar once its time has come", () => {
	const note = { "note:x": { due: dayOf(now), title: "x", at: "15:00" } };
	expect(showsBar(note, 0, now)).toBe(false);
	expect(showsBar(note, 0, new Date(2026, 9, 20, 15).getTime())).toBe(true);
});

test("an approval the watcher pings for raises the Reminders bar", () => {
	const pr = "pr:https://github.com/o/r/pull/9";
	useReplyWatch.getState().toggle([pr], "Fix login", "pane-9");
	const activity = {
		[pr]: { stamp: "approved", byMe: false, text: "Fix login", url: null },
	};
	// One watcher tick: the ping, then the stamp and the unread reply.
	const { watches, setStamps } = useReplyWatch.getState();
	const pinged = newReplies(watches, activity);
	expect(pinged).toEqual([pr]);
	setStamps({ [pr]: "approved" }, { [pr]: "Fix login" });
	const pings = unreadPings(useReplyWatch.getState().watches);
	expect(pings.map((p) => [p.key, p.event])).toEqual([[pr, "Approved"]]);
	// No reminders at all: the unread approval alone shows the bar.
	expect(showsBar({}, pings.length, Date.now())).toBe(true);
	useReplyWatch.getState().toggle([], "", "pane-9");
});
