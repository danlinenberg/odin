import { expect, test } from "bun:test";
import { isCalendarMail, parseTriage } from "./email-triage";

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
