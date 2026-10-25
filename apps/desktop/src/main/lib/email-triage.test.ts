import { expect, test } from "bun:test";
import { isCalendarMail } from "shared/calendar-mail";
import { ignoredSender, parseTriage, triagePrompt } from "./email-triage";

test("invites, RSVPs and cancellations are calendar mail; replies about them aren't", () => {
	for (const subject of [
		"Invitation: Studio chaser 🍻 @ Tue Sep 29, 2026 2:45pm",
		"Updated invitation: Pre-sync @ Tue",
		"Accepted: RE Web App Workshop @ Wed",
		"Declined: Standup",
		"Canceled event: Retro @ Fri",
	])
		expect([subject, isCalendarMail(subject)]).toEqual([subject, true]);
	for (const subject of ["Re: invitation to speak", "test"])
		expect([subject, isCalendarMail(subject)]).toEqual([subject, false]);
});

test("the answer's line numbers become ids; junk is everything unnamed", () => {
	expect(
		parseTriage('Sure: {"interesting": [2, 9, "x"]}', ["a", "b", "c"]),
	).toEqual(new Set(["b"]));
	expect(parseTriage("no json here", ["a"])).toBeNull();
	expect(parseTriage('{"order": [1]}', ["a"])).toBeNull();
});

test("an ignored sender's address is junk, in any case; a name alone matches nothing", () => {
	const ignored = [{ from: "Luma", fromEmail: "Calendar@lu.ma", subject: "x" }];
	const mail = (fromEmail: string | null) => ({
		id: "1",
		subject: "New registration",
		snippet: "",
		from: "Luma",
		fromEmail,
	});
	expect(ignoredSender(mail("calendar@lu.ma"), ignored)).toBe(true);
	expect(ignoredSender(mail("dan@lu.ma"), ignored)).toBe(false);
	expect(ignoredSender(mail(null), [{ ...ignored[0], fromEmail: null }])).toBe(
		false,
	);
});

test("ignored mail rides along in the prompt as examples", () => {
	expect(triagePrompt([])).not.toContain("ignore mail like these");
	expect(
		triagePrompt([
			{ from: "Cameron", fromEmail: "c@sentry.io", subject: "Usage Alignment" },
		]),
	).toContain("- Cameron <c@sentry.io> | Usage Alignment");
});
