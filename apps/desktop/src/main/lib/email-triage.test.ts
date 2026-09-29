import { expect, test } from "bun:test";
import { isCalendarMail, parseTriage } from "./email-triage";

test("calendar traffic is recognised by its subject", () => {
	for (const subject of [
		"Invitation: Studio chaser 🍻 @ Tue Sep 29, 2026 2:45pm",
		"Updated invitation: Pre-sync @ Tue",
		"Accepted: RE Web App Workshop @ Wed",
		"Declined: Standup",
		"Canceled event: Retro @ Fri",
	])
		expect([subject, isCalendarMail(subject)]).toEqual([subject, true]);
	expect(isCalendarMail("Re: invitation to speak")).toBe(false);
	expect(isCalendarMail("test")).toBe(false);
});

test("the answer's line numbers become ids; junk is everything unnamed", () => {
	expect(
		parseTriage('Sure: {"interesting": [2, 9, "x"]}', ["a", "b", "c"]),
	).toEqual(new Set(["b"]));
	expect(parseTriage("no json here", ["a"])).toBeNull();
	expect(parseTriage('{"order": [1]}', ["a"])).toBeNull();
});
