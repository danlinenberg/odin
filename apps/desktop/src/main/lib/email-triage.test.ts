import { expect, test } from "bun:test";
import { isCalendarInvite, isCalendarReply, parseTriage } from "./email-triage";

test("invites are told apart from RSVPs by their subject", () => {
	for (const subject of [
		"Invitation: Studio chaser 🍻 @ Tue Sep 29, 2026 2:45pm",
		"Updated invitation: Pre-sync @ Tue",
	])
		expect([
			subject,
			isCalendarInvite(subject),
			isCalendarReply(subject),
		]).toEqual([subject, true, false]);
	for (const subject of [
		"Accepted: RE Web App Workshop @ Wed",
		"Declined: Standup",
		"Canceled event: Retro @ Fri",
	])
		expect([
			subject,
			isCalendarInvite(subject),
			isCalendarReply(subject),
		]).toEqual([subject, false, true]);
	for (const subject of ["Re: invitation to speak", "test"])
		expect([isCalendarInvite(subject), isCalendarReply(subject)]).toEqual([
			false,
			false,
		]);
});

test("the answer's line numbers become ids; junk is everything unnamed", () => {
	expect(
		parseTriage('Sure: {"interesting": [2, 9, "x"]}', ["a", "b", "c"]),
	).toEqual(new Set(["b"]));
	expect(parseTriage("no json here", ["a"])).toBeNull();
	expect(parseTriage('{"order": [1]}', ["a"])).toBeNull();
});
