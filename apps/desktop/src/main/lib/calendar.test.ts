import { expect, test } from "bun:test";
import { normalizeCalendarUrl, parseMeetings } from "./calendar";

const ME = "dan@example.com";

/** A Google-style secret-address feed: CRLF, folded lines, a VTIMEZONE. */
function feed(events: string[]): string {
	return [
		"BEGIN:VCALENDAR",
		"PRODID:-//Google Inc//Google Calendar 70.9054//EN",
		"VERSION:2.0",
		`X-WR-CALNAME:${ME}`,
		"X-WR-TIMEZONE:Asia/Jerusalem",
		"BEGIN:VTIMEZONE",
		"TZID:Asia/Jerusalem",
		"BEGIN:DAYLIGHT",
		"TZOFFSETFROM:+0200",
		"TZOFFSETTO:+0300",
		"TZNAME:IDT",
		"DTSTART:19700327T020000",
		"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1FR",
		"END:DAYLIGHT",
		"BEGIN:STANDARD",
		"TZOFFSETFROM:+0300",
		"TZOFFSETTO:+0200",
		"TZNAME:IST",
		"DTSTART:19701025T020000",
		"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
		"END:STANDARD",
		"END:VTIMEZONE",
		...events,
		"END:VCALENDAR",
	].join("\r\n");
}

const attendee = (email: string, name: string, partstat = "ACCEPTED") =>
	`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat};CN=${name}:mailto:${email}`;

const ofek = attendee("ofek@example.com", "Ofek Azulay");

// Wednesday 2026-10-21, 06:00 UTC = 09:00 in Tel Aviv (IDT, +3).
const NOW = Date.parse("2026-10-21T06:00:00Z");
const WINDOW = { from: NOW, to: NOW + 3 * 86_400_000 };

const titles = (ics: string) =>
	parseMeetings(ics, WINDOW).map((meeting) => meeting.title);

test("a weekly series expands to the occurrences in the window, in their own time zone", () => {
	const ics = feed([
		"BEGIN:VEVENT",
		"DTSTART;TZID=Asia/Jerusalem:20260902T100000",
		"DTEND;TZID=Asia/Jerusalem:20260902T103000",
		"RRULE:FREQ=WEEKLY;BYDAY=WE,TH",
		"UID:weekly@google.com",
		"SUMMARY:R&D sync",
		`ORGANIZER;CN=Ofek Azulay:mailto:ofek@example.com`,
		ofek,
		attendee(ME, "Dan"),
		"END:VEVENT",
	]);
	const meetings = parseMeetings(ics, WINDOW);
	expect(meetings.map((m) => m.start)).toEqual([
		"2026-10-21T07:00:00.000Z",
		"2026-10-22T07:00:00.000Z",
	]);
	expect(meetings[0]).toMatchObject({
		id: "weekly@google.com@2026-10-21T07:00:00.000Z",
		title: "R&D sync",
		end: "2026-10-21T07:30:00.000Z",
		organizer: "Ofek Azulay",
		attendees: ["Ofek Azulay"],
		recurring: true,
	});
});

test("a moved occurrence takes its new time, and a cancelled or excluded one is gone", () => {
	const ics = feed([
		"BEGIN:VEVENT",
		"DTSTART;TZID=Asia/Jerusalem:20260901T120000",
		"DTEND;TZID=Asia/Jerusalem:20260901T130000",
		"RRULE:FREQ=DAILY",
		"EXDATE;TZID=Asia/Jerusalem:20261023T120000",
		"UID:daily@google.com",
		"SUMMARY:Standup",
		ofek,
		attendee(ME, "Dan"),
		"END:VEVENT",
		"BEGIN:VEVENT",
		"RECURRENCE-ID;TZID=Asia/Jerusalem:20261021T120000",
		"DTSTART;TZID=Asia/Jerusalem:20261021T150000",
		"DTEND;TZID=Asia/Jerusalem:20261021T160000",
		"UID:daily@google.com",
		"SUMMARY:Standup (moved)",
		ofek,
		attendee(ME, "Dan"),
		"END:VEVENT",
		"BEGIN:VEVENT",
		"RECURRENCE-ID;TZID=Asia/Jerusalem:20261022T120000",
		"DTSTART;TZID=Asia/Jerusalem:20261022T120000",
		"DTEND;TZID=Asia/Jerusalem:20261022T130000",
		"STATUS:CANCELLED",
		"UID:daily@google.com",
		"SUMMARY:Standup",
		"END:VEVENT",
	]);
	expect(parseMeetings(ics, WINDOW).map((m) => [m.title, m.start])).toEqual([
		["Standup (moved)", "2026-10-21T12:00:00.000Z"],
	]);
});

test("declined, solo, all-day and ended events are not meetings to prepare for", () => {
	const ics = feed([
		"BEGIN:VEVENT",
		"DTSTART:20261021T130000Z",
		"DTEND:20261021T140000Z",
		"UID:declined@google.com",
		"SUMMARY:Declined",
		ofek,
		attendee(ME, "Dan", "DECLINED"),
		"END:VEVENT",
		"BEGIN:VEVENT",
		"DTSTART:20261021T130000Z",
		"DTEND:20261021T140000Z",
		"UID:focus@google.com",
		"SUMMARY:Focus time",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"DTSTART;VALUE=DATE:20261022",
		"DTEND;VALUE=DATE:20261023",
		"UID:holiday@google.com",
		"SUMMARY:Out of office",
		ofek,
		"END:VEVENT",
		"BEGIN:VEVENT",
		"DTSTART:20261021T040000Z",
		"DTEND:20261021T050000Z",
		"UID:ended@google.com",
		"SUMMARY:Already over",
		ofek,
		"END:VEVENT",
		"BEGIN:VEVENT",
		"DTSTART:20261021T053000Z",
		"DTEND:20261021T063000Z",
		"UID:running@google.com",
		"SUMMARY:Running now",
		ofek,
		"END:VEVENT",
		"BEGIN:VEVENT",
		"DTSTART:20261030T090000Z",
		"DTEND:20261030T100000Z",
		"UID:later@google.com",
		"SUMMARY:Next week",
		ofek,
		"END:VEVENT",
	]);
	expect(titles(ics)).toEqual(["Running now"]);
});

test("the join link comes from Google's conference field, else the location or the agenda", () => {
	const ics = feed([
		"BEGIN:VEVENT",
		"DTSTART:20261021T130000Z",
		"DTEND:20261021T140000Z",
		"UID:meet@google.com",
		"SUMMARY:Roadmap review",
		"X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
		"DESCRIPTION:Agenda: Q4 plan\\n\\n-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-\\nJoin with Google Meet: https://meet.google.com/abc-defg-hij\\n-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-",
		ofek,
		"END:VEVENT",
		"BEGIN:VEVENT",
		"DTSTART:20261021T150000Z",
		"DTEND:20261021T160000Z",
		"UID:zoom@example.com",
		"SUMMARY:Vendor call",
		"LOCATION:https://acme.zoom.us/j/123456?pwd=xyz",
		ofek,
		"END:VEVENT",
	]);
	const [meet, zoom] = parseMeetings(ics, WINDOW);
	expect(meet).toMatchObject({
		joinUrl: "https://meet.google.com/abc-defg-hij",
		description: "Agenda: Q4 plan",
		location: null,
		recurring: false,
	});
	expect(zoom).toMatchObject({
		joinUrl: "https://acme.zoom.us/j/123456?pwd=xyz",
		location: null,
	});
});

test("an organizer who is you isn't named, and extra addresses count as you", () => {
	const ics = feed([
		"BEGIN:VEVENT",
		"DTSTART:20261021T130000Z",
		"DTEND:20261021T140000Z",
		"UID:mine@google.com",
		"SUMMARY:1:1",
		`ORGANIZER;CN=Dan:mailto:${ME}`,
		attendee("dan@work.example", "Dan (work)"),
		ofek,
		"END:VEVENT",
	]);
	const [meeting] = parseMeetings(ics, WINDOW, ["DAN@work.example"]);
	expect(meeting).toMatchObject({
		organizer: null,
		attendees: ["Ofek Azulay"],
	});
});

test("webcal links become https, and anything that isn't https is refused", () => {
	expect(normalizeCalendarUrl(" webcal://p01-caldav.icloud.com/x.ics ")).toBe(
		"https://p01-caldav.icloud.com/x.ics",
	);
	expect(
		normalizeCalendarUrl(
			"https://calendar.google.com/calendar/ical/dan%40example.com/private-abc/basic.ics",
		),
	).toBe(
		"https://calendar.google.com/calendar/ical/dan%40example.com/private-abc/basic.ics",
	);
	expect(normalizeCalendarUrl("http://example.com/cal.ics")).toBeNull();
	expect(normalizeCalendarUrl("not a url")).toBeNull();
});
