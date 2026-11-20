import { expect, test } from "bun:test";
import { markdownImages } from "../routes/_authenticated/_odin/board/launch-request";
import { ago } from "./cards";
import {
	leadingTldr,
	messageTime,
	segments,
	userBubbleText,
} from "./transcript";

const user = (text: string) => ({ role: "user" as const, text });
const odin = (text: string) => ({ role: "assistant" as const, text });

test("a TL;DR shows only for a reply too long to read at a glance", () => {
	const short = { last: "Fixed the sort.", urgency: null, long: false };
	expect(leadingTldr(short)).toBeNull();
	expect(leadingTldr({ ...short, long: true })).toEqual({
		...short,
		long: true,
	});
	expect(leadingTldr(null)).toBeNull();
});

test("a turn's in-between messages fold; its last answer stays open", () => {
	const shape = segments([
		user("q1"),
		odin("step a"),
		odin("step b"),
		odin("answer 1"),
		user("q2"),
		odin("answer 2"),
	]).map((s) =>
		s.kind === "fold"
			? `fold(${s.messages.map((m) => m.message.text).join(",")})`
			: s.message.text,
	);
	expect(shape).toEqual([
		"q1",
		"fold(step a,step b)",
		"answer 1",
		"q2",
		"answer 2",
	]);
});

test("a turn still running folds what came before its latest message", () => {
	const shape = segments([user("q"), odin("a"), odin("b")]).map((s) => s.kind);
	expect(shape).toEqual(["message", "fold", "message"]);
});

test("ago reads minutes, hours, days", () => {
	const now = 1_000_000_000;
	expect(ago(now - 20_000, now)).toBe("now");
	expect(ago(now - 5 * 60_000, now)).toBe("5m");
	expect(ago(now - 3 * 3_600_000, now)).toBe("3h");
	expect(ago(now - 2 * 86_400_000, now)).toBe("2d");
});

test("a launch prompt shows only your request until you ask for Odin's part", () => {
	const prompt = [
		"Task: Test",
		"",
		"Standing rules - follow each one whenever its situation comes up during this session, without being asked:\n- When you open a pull request: auto merge",
		"",
		"Work in the current workspace. Investigate, make the changes.",
	].join("\n");
	const folded = userBubbleText(prompt, { full: false, images: false });
	expect(folded).toEqual({ shown: "Task: Test", folds: true });
	const full = userBubbleText(prompt, { full: true, images: false });
	expect(full.shown).toBe(prompt);
	expect(full.folds).toBe(true);
});

test("a Slack thread task folds to the message, not Odin's phases", () => {
	const prompt = [
		"Task: Fix the sort",
		"",
		"This task comes from a Slack thread: https://example.com/archives/C0123/p1",
		"",
		"What was posted there:",
		"the sort is broken",
		"",
		"PHASE 1 - INGEST (do this first, before anything else):",
		"- Read the ENTIRE thread",
		"",
		"Work in the current workspace.",
	].join("\n");
	expect(userBubbleText(prompt, { full: false, images: false }).shown).toBe(
		"Task: Fix the sort\n\nThis task comes from a Slack thread: https://example.com/archives/C0123/p1\n\nWhat was posted there:\nthe sort is broken",
	);
});

test("a folded launch prompt names its attached files; thumbnails replace images", () => {
	const prompt = [
		"Task: Look at this",
		"",
		"Attached files - read them before starting:",
		"/Users/me/odin/attachments/shot.png",
		"/Users/me/odin/attachments/notes.pdf",
		"",
		"Work in the current workspace.",
	].join("\n");
	expect(userBubbleText(prompt, { full: false, images: false }).shown).toBe(
		"Task: Look at this\n\n📎 shot.png, notes.pdf",
	);
	expect(userBubbleText(prompt, { full: false, images: true }).shown).toBe(
		"Task: Look at this\n\n📎 notes.pdf",
	);
});

test("a typed message shows whole, however long; image tags go", () => {
	expect(
		userBubbleText("Fix it\n\nThanks", { full: false, images: false }),
	).toEqual({ shown: "Fix it\n\nThanks", folds: false });
	const long = "a\nb\nc\nd\ne\nf\ng".repeat(50);
	expect(userBubbleText(long, { full: false, images: false }).shown).toBe(long);
	expect(
		userBubbleText("Look [Image #1] here", { full: false, images: true }).shown,
	).toBe("Look here");
});

test("a message's time reads as the board's; none without one", () => {
	expect(messageTime(null)).toBeNull();
	expect(messageTime("not a date")).toBeNull();
	expect(messageTime("2026-10-19T20:29:00Z")).toMatch(/Oct/);
});

test("a task's ![](path) images show as thumbnails, not as their paths", () => {
	const prompt = [
		"Task: Fix the phone",
		"",
		"![](/home/me/.odin/files/0-a.png)",
		"",
		"![](/home/me/.odin/files/1-b.jpeg)",
		"",
		"Work in the current workspace.",
	].join("\n");
	expect(markdownImages(prompt)).toEqual([
		"/home/me/.odin/files/0-a.png",
		"/home/me/.odin/files/1-b.jpeg",
	]);
	expect(userBubbleText(prompt, { full: false, images: true }).shown).toBe(
		"Task: Fix the phone",
	);
	// No thumbnail came (the file is gone): the path stays, so nothing is lost.
	expect(
		userBubbleText(prompt, { full: false, images: false }).shown,
	).toContain("![](/home/me/.odin/files/0-a.png)");
});
