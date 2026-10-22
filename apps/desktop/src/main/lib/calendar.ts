import ICAL from "ical.js";

/**
 * Meetings for the Calendar feed, from either of its two ways in.
 *
 * Signed in to Google: the Calendar API, which expands recurring series
 * itself (`singleEvents`). Otherwise the secret iCal address that Google,
 * Outlook and iCloud all publish, read with one GET. ical.js does the parts
 * of that file that are easy to get wrong by hand - recurring series, their
 * moved and cancelled occurrences, and the VTIMEZONE blocks the times are in.
 * Both produce the same rows with the same ids, so switching between them
 * keeps what was marked Done.
 */

/** One upcoming meeting, a single occurrence of a series. */
export interface MeetingRow {
	/** The event's UID plus this occurrence's start: a series repeats the UID. */
	id: string;
	title: string;
	/** ISO, UTC. */
	start: string;
	end: string;
	organizer: string | null;
	/** Everyone invited but you, by name where the invite gives one. */
	attendees: string[];
	location: string | null;
	/** Meet, Zoom, Teams or Webex - what Open goes to. */
	joinUrl: string | null;
	description: string | null;
	recurring: boolean;
}

/** Google shows the address as https; Apple's and Outlook's share links say webcal. */
export function normalizeCalendarUrl(raw: string): string | null {
	const url = raw.trim().replace(/^webcals?:\/\//i, "https://");
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" ? parsed.toString() : null;
	} catch {
		return null;
	}
}

export function fetchCalendar(url: string): Promise<Response> {
	return fetch(url, { headers: { Accept: "text/calendar" } });
}

/**
 * The calendar's name, for Settings to show who it is - Google names a
 * primary calendar by its address. Null when the body isn't a calendar at all,
 * which is what a wrong link (a sign-in page, the public HTML view) returns.
 */
export function calendarIdentity(body: string): string | null {
	if (!/^BEGIN:VCALENDAR/m.test(body)) return null;
	const name = body.match(/^X-WR-CALNAME:(.*)$/m)?.[1]?.trim();
	return name || "connected";
}

const JOIN_URL =
	/https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com|[\w.-]*webex\.com)\/[^\s<>"')\]]+/i;

/** Google appends its Meet boilerplate after this line; the agenda is above it. */
const GOOGLE_FOOTER = /\n?-::~[:~]+[\s\S]*$/;

const MAX_OCCURRENCES = 20_000;

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function address(property: ICAL.Property): string {
	const value = String(property.getFirstValue() ?? "");
	return value.replace(/^mailto:/i, "").toLowerCase();
}

function nameOf(property: ICAL.Property): string {
	const cn = property.getParameter("cn");
	return (typeof cn === "string" && cn.trim()) || address(property);
}

/**
 * The meetings that haven't ended and start before `to`, soonest first.
 *
 * A meeting has someone else in it: a block on your own calendar (focus time,
 * a reminder to yourself) has no attendees and isn't something to prepare for.
 * All-day events are out too - holidays and out-of-office, not meetings - and
 * so is anything cancelled or that you declined. `self` is every address that
 * is you; the calendar's own name is added when it's an address, which is how
 * Google names a primary calendar.
 */
export function parseMeetings(
	ics: string,
	window: { from: number; to: number },
	self: string[] = [],
): MeetingRow[] {
	const root = new ICAL.Component(ICAL.parse(ics));
	for (const zone of root.getAllSubcomponents("vtimezone")) {
		const tzid = zone.getFirstPropertyValue("tzid");
		if (typeof tzid === "string" && !ICAL.TimezoneService.has(tzid)) {
			ICAL.TimezoneService.register(zone);
		}
	}
	const me = new Set(self.map((value) => value.toLowerCase()));
	const calendarName = text(root.getFirstPropertyValue("x-wr-calname"));
	if (calendarName?.includes("@")) me.add(calendarName.toLowerCase());

	const events = root
		.getAllSubcomponents("vevent")
		.map((component) => new ICAL.Event(component));
	const series = new Map<string, ICAL.Event>();
	for (const event of events) {
		if (!event.isRecurrenceException()) series.set(event.uid, event);
	}
	for (const event of events) {
		if (event.isRecurrenceException())
			series.get(event.uid)?.relateException(event);
	}

	const rows: MeetingRow[] = [];
	const take = (event: ICAL.Event, start: ICAL.Time, end: ICAL.Time) => {
		if (start.isDate) return;
		const startMs = start.toJSDate().getTime();
		const endMs = end.toJSDate().getTime();
		if (endMs <= window.from || startMs >= window.to) return;
		const meeting = toMeeting(event, startMs, endMs, me);
		if (meeting) rows.push(meeting);
	};

	for (const event of series.values()) {
		if (!event.isRecurring()) {
			take(event, event.startDate, event.endDate);
			continue;
		}
		const iterator = event.iterator();
		for (let i = 0; i < MAX_OCCURRENCES; i++) {
			const next = iterator.next();
			if (!next || next.toJSDate().getTime() >= window.to) break;
			const occurrence = event.getOccurrenceDetails(next);
			take(occurrence.item, occurrence.startDate, occurrence.endDate);
		}
	}
	// A moved occurrence whose series isn't in the feed still happened.
	for (const event of events) {
		if (event.isRecurrenceException() && !series.has(event.uid)) {
			take(event, event.startDate, event.endDate);
		}
	}
	return rows.sort((a, b) => a.start.localeCompare(b.start));
}

function toMeeting(
	event: ICAL.Event,
	startMs: number,
	endMs: number,
	me: Set<string>,
): MeetingRow | null {
	const component = event.component;
	const status = text(component.getFirstPropertyValue("status"));
	if (status?.toUpperCase() === "CANCELLED") return null;

	const attendees = event.attendees;
	const mine = attendees.find((attendee) => me.has(address(attendee)));
	const answer = mine?.getParameter("partstat");
	if (typeof answer === "string" && answer.toUpperCase() === "DECLINED") {
		return null;
	}
	const others = attendees.filter((attendee) => !me.has(address(attendee)));
	if (others.length === 0) return null;

	const organizerProperty = component.getFirstProperty("organizer");
	const organizer =
		organizerProperty && !me.has(address(organizerProperty))
			? nameOf(organizerProperty)
			: null;
	const location = text(event.location);
	const rawDescription = text(event.description);
	const conference = text(
		component.getFirstPropertyValue("x-google-conference"),
	);
	const joinUrl =
		conference ??
		[location, rawDescription]
			.map((value) => value?.match(JOIN_URL)?.[0] ?? null)
			.find(Boolean) ??
		null;
	const description = text(rawDescription?.replace(GOOGLE_FOOTER, ""));
	const start = new Date(startMs).toISOString();
	return {
		id: `${event.uid}@${start}`,
		title: text(event.summary) ?? "(no title)",
		start,
		end: new Date(endMs).toISOString(),
		organizer,
		attendees: others.map(nameOf),
		location: location && location !== joinUrl ? location : null,
		joinUrl,
		description: description?.slice(0, 4000) ?? null,
		recurring: event.isRecurring() || event.isRecurrenceException(),
	};
}

// --- Google Calendar API ----------------------------------------------------

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** The pages of one window a person can plausibly have; a guard, not a limit. */
const MAX_PAGES = 10;

export function googleCalendarFetch(
	path: string,
	token: string,
): Promise<Response> {
	return fetch(`${GOOGLE_CALENDAR_API}/${path}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
}

/** The primary calendar's id, which is the account's address. */
export async function primaryCalendarId(token: string): Promise<string | null> {
	try {
		const res = await googleCalendarFetch("calendars/primary", token);
		if (!res.ok) return null;
		const json = (await res.json()) as { id?: string; summary?: string };
		return json.id ?? json.summary ?? null;
	} catch {
		return null;
	}
}

interface GooglePerson {
	email?: string;
	displayName?: string;
	self?: boolean;
	resource?: boolean;
	responseStatus?: string;
}

export interface GoogleEvent {
	id?: string;
	iCalUID?: string;
	status?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: { dateTime?: string; date?: string };
	end?: { dateTime?: string; date?: string };
	organizer?: GooglePerson;
	attendees?: GooglePerson[];
	hangoutLink?: string;
	conferenceData?: {
		entryPoints?: { entryPointType?: string; uri?: string }[];
	};
	recurringEventId?: string;
}

/**
 * The primary calendar's meetings in the window, through the API. A failed
 * page comes back as its status and body, so the caller can say what went
 * wrong.
 */
export async function fetchGoogleMeetings(
	token: string,
	window: { from: number; to: number },
	self: string[] = [],
): Promise<
	| { ok: true; meetings: MeetingRow[] }
	| { ok: false; status: number; body: string }
> {
	const events: GoogleEvent[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const query = new URLSearchParams({
			timeMin: new Date(window.from).toISOString(),
			timeMax: new Date(window.to).toISOString(),
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: "250",
		});
		if (pageToken) query.set("pageToken", pageToken);
		const res = await googleCalendarFetch(
			`calendars/primary/events?${query}`,
			token,
		);
		if (!res.ok)
			return { ok: false, status: res.status, body: await res.text() };
		const json = (await res.json()) as {
			items?: GoogleEvent[];
			nextPageToken?: string;
		};
		events.push(...(json.items ?? []));
		pageToken = json.nextPageToken;
		if (!pageToken) break;
	}
	return { ok: true, meetings: parseGoogleEvents(events, window, self) };
}

/** Google's descriptions are HTML; the agenda wants the text. */
function plainText(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

/**
 * The same rows `parseMeetings` makes, from API events: the same rules for
 * what counts as a meeting (someone else is in it, not all-day, not
 * cancelled, not declined) and the same `uid@start` ids.
 */
export function parseGoogleEvents(
	events: GoogleEvent[],
	window: { from: number; to: number },
	self: string[] = [],
): MeetingRow[] {
	const me = new Set(self.map((value) => value.toLowerCase()));
	const isMe = (person: GooglePerson) =>
		person.self === true || me.has((person.email ?? "").toLowerCase());
	const nameOfPerson = (person: GooglePerson) =>
		text(person.displayName) ?? (person.email ?? "").toLowerCase();

	const rows: MeetingRow[] = [];
	for (const event of events) {
		if (event.status === "cancelled") continue;
		const startIso = event.start?.dateTime;
		const endIso = event.end?.dateTime;
		if (!startIso || !endIso) continue;
		const startMs = Date.parse(startIso);
		const endMs = Date.parse(endIso);
		if (endMs <= window.from || startMs >= window.to) continue;

		const attendees = event.attendees ?? [];
		if (attendees.find(isMe)?.responseStatus === "declined") continue;
		const others = attendees.filter(
			(person) => !isMe(person) && !person.resource,
		);
		if (others.length === 0) continue;

		const location = text(event.location);
		const rawDescription = text(
			event.description ? plainText(event.description) : null,
		);
		const conference =
			text(event.hangoutLink) ??
			text(
				event.conferenceData?.entryPoints?.find(
					(point) => point.entryPointType === "video",
				)?.uri,
			);
		const joinUrl =
			conference ??
			[location, rawDescription]
				.map((value) => value?.match(JOIN_URL)?.[0] ?? null)
				.find(Boolean) ??
			null;
		const description = text(rawDescription?.replace(GOOGLE_FOOTER, ""));
		const start = new Date(startMs).toISOString();
		rows.push({
			id: `${event.iCalUID ?? event.id}@${start}`,
			title: text(event.summary) ?? "(no title)",
			start,
			end: new Date(endMs).toISOString(),
			organizer:
				event.organizer && !isMe(event.organizer)
					? nameOfPerson(event.organizer)
					: null,
			attendees: others.map(nameOfPerson),
			location: location && location !== joinUrl ? location : null,
			joinUrl,
			description: description?.slice(0, 4000) ?? null,
			recurring: Boolean(event.recurringEventId),
		});
	}
	return rows.sort((a, b) => a.start.localeCompare(b.start));
}
