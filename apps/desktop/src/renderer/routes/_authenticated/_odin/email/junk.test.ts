import { expect, test } from "bun:test";
import { isJunkEmail } from "./junk";

// A real inbox, sorted by hand.
const junk = [
	"noreply@md.getsentry.com",
	"noreply@luma-mail.com",
	"automation@imagen-ai.atlassian.net",
	"info@imagen-ai.com",
	"support@meshpayments.com",
	"notifications@shapes.co",
	"noreply+8bede68@id.atlassian.net",
	"grok-bot@mail.cursor.com",
	"announcements@figma.com",
	"team@mail.airtable.com",
];
const people = [
	"dan.l@imagen-ai.com",
	"ardon.w@imagen-ai.com",
	"lior.k@imagen-ai.com",
	"jacqui.m@imagen-ai.com",
	"robert@gmail.com",
];

test("machine senders are junk", () => {
	for (const fromEmail of junk)
		expect([fromEmail, isJunkEmail({ fromEmail })]).toEqual([fromEmail, true]);
});

test("people are not", () => {
	for (const fromEmail of people)
		expect([fromEmail, isJunkEmail({ fromEmail })]).toEqual([fromEmail, false]);
});

test("no address says nothing", () => {
	expect(isJunkEmail({ fromEmail: null })).toBe(false);
});
