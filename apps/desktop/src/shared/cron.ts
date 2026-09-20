/**
 * The five-field cron an automation runs on — minute, hour, day-of-month,
 * month, day-of-week — plus the `@daily` shorthands people actually type.
 *
 * ponytail: ~60 lines instead of a dependency. It covers wildcards, single
 * values, ranges, steps (`a-b/n`) and comma lists, which is every schedule
 * the panel offers and every one anyone writes by hand. Reach for a library
 * the day someone needs `L`, `W`, `#` or a timezone other than this Mac's.
 */

/** [lo, hi] per field, in order. */
const RANGES: [number, number][] = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 6],
];

const ALIASES: Record<string, string> = {
	"@hourly": "0 * * * *",
	"@daily": "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@weekly": "0 0 * * 0",
	"@monthly": "0 0 1 * *",
};

export interface Cron {
	/** Every value each field matches. */
	fields: Set<number>[];
	/** Whether day-of-month / day-of-week were narrowed — see cronMatches. */
	domRestricted: boolean;
	dowRestricted: boolean;
}

function parseField(part: string, lo: number, hi: number): Set<number> | null {
	// Sunday is 0 or 7 in cron, so day-of-week alone accepts one over its top
	// and folds it back. Nothing else may: hour 7 is 7.
	const isWeekday = lo === 0 && hi === 6;
	const max = isWeekday ? 7 : hi;
	const out = new Set<number>();
	for (const chunk of part.split(",")) {
		const [range = "", step = "1", extra] = chunk.split("/");
		const by = Number(step);
		if (extra !== undefined || !Number.isInteger(by) || by < 1) return null;
		let from = lo;
		let to = hi;
		if (range !== "*") {
			const [a = "", b = a] = range.split("-");
			if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
			from = Number(a);
			to = Number(b);
		}
		if (from < lo || to > max || from > to) return null;
		for (let value = from; value <= to; value += by) {
			out.add(isWeekday && value === 7 ? 0 : value);
		}
	}
	return out.size > 0 ? out : null;
}

/** The schedule, or null if that isn't one. */
export function parseCron(expr: string): Cron | null {
	const text = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
	const parts = text.split(/\s+/);
	if (parts.length !== 5) return null;
	const fields: Set<number>[] = [];
	for (const [index, part] of parts.entries()) {
		const [lo, hi] = RANGES[index] as [number, number];
		const set = parseField(part, lo, hi);
		if (!set) return null;
		fields.push(set);
	}
	return {
		fields,
		domRestricted: parts[2] !== "*",
		dowRestricted: parts[4] !== "*",
	};
}

export const isValidCron = (expr: string): boolean => parseCron(expr) !== null;

/** Does this minute fall on the schedule? Seconds are ignored. */
export function cronMatches(cron: Cron, date: Date): boolean {
	const [min, hour, dom, mon, dow] = cron.fields;
	if (
		!min?.has(date.getMinutes()) ||
		!hour?.has(date.getHours()) ||
		!mon?.has(date.getMonth() + 1)
	) {
		return false;
	}
	const onDay = !!dom?.has(date.getDate());
	const onWeekday = !!dow?.has(date.getDay());
	// Cron's one oddity: with BOTH day fields narrowed they're OR'd, not AND'd
	// — "0 9 1 * 1" is the 1st and every Monday, not Mondays that are the 1st.
	return cron.domRestricted && cron.dowRestricted
		? onDay || onWeekday
		: onDay && onWeekday;
}

/**
 * The next minute this fires, searching forward from `from` (exclusive).
 *
 * ponytail: it steps a minute at a time over a year — half a million set
 * lookups in the worst case, and the worst case is a schedule that never
 * fires (February 30th). A real one lands within a day. Walk the fields
 * instead if this ever shows up in a profile.
 */
export function nextRun(expr: string, from: Date = new Date()): Date | null {
	const cron = parseCron(expr);
	if (!cron) return null;
	const at = new Date(from);
	at.setSeconds(0, 0);
	at.setMinutes(at.getMinutes() + 1);
	for (let i = 0; i < 366 * 24 * 60; i++) {
		if (cronMatches(cron, at)) return at;
		at.setMinutes(at.getMinutes() + 1);
	}
	return null;
}

// ---------------------------------------------------------------------------
// The schedule behind the picker
//
// Cron is what gets stored and matched; nobody should have to write one. These
// are the shapes the picker offers, and the round trip between them and a cron
// string. Anything a picker can't express stays a cron and is shown as one.
// ---------------------------------------------------------------------------

export type Repeat =
	| "15m"
	| "30m"
	| "hourly"
	| "daily"
	| "weekdays"
	| "weekly"
	| "monthly";

export interface Schedule {
	repeat: Repeat;
	/** "HH:MM". Unused by the sub-hourly repeats, kept so switching keeps it. */
	time: string;
	/** 0–6, Sunday first — weekly only. */
	weekday: number;
	/** 1–28 — monthly only. The 29th-31st don't exist in every month. */
	day: number;
}

/** What a new automation starts as: weekdays at 09:00. */
export const DEFAULT_SCHEDULE: Schedule = {
	repeat: "weekdays",
	time: "09:00",
	weekday: 1,
	day: 1,
};

const pad = (n: number) => String(n).padStart(2, "0");

export function cronOf(schedule: Schedule): string {
	const [hh = "0", mm = "0"] = schedule.time.split(":");
	const h = Number(hh) || 0;
	const m = Number(mm) || 0;
	switch (schedule.repeat) {
		case "15m":
			return "*/15 * * * *";
		case "30m":
			return "*/30 * * * *";
		case "hourly":
			return "0 * * * *";
		case "daily":
			return `${m} ${h} * * *`;
		case "weekdays":
			return `${m} ${h} * * 1-5`;
		case "weekly":
			return `${m} ${h} * * ${schedule.weekday}`;
		case "monthly":
			return `${m} ${h} ${schedule.day} * *`;
	}
}

/**
 * The picker's reading of a cron, or null when it has none — a cron the picker
 * can't express must stay exactly as written, so this is deliberately strict.
 * "Every hour" is `0 * * * *` and nothing else: accepting `15 * * * *` would
 * mean re-rendering it as "every hour" and quietly saving away the :15.
 */
export function scheduleOf(expr: string): Schedule | null {
	const text = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
	const [mi = "", ho = "", dom = "", mon = "", dow = "", extra] =
		text.split(/\s+/);
	if (extra !== undefined || dow === "" || mon !== "*") return null;
	const num = (s: string) => (/^\d{1,2}$/.test(s) ? Number(s) : null);
	const at = (h: number, m: number) => ({
		...DEFAULT_SCHEDULE,
		time: `${pad(h)}:${pad(m)}`,
	});

	if (dom === "*" && dow === "*" && ho === "*") {
		if (mi === "*/15") return { ...DEFAULT_SCHEDULE, repeat: "15m" };
		if (mi === "*/30") return { ...DEFAULT_SCHEDULE, repeat: "30m" };
		if (mi === "0") return { ...DEFAULT_SCHEDULE, repeat: "hourly" };
		return null;
	}
	const m = num(mi);
	const h = num(ho);
	if (m === null || h === null || m > 59 || h > 23) return null;
	if (dom === "*" && dow === "*") return { ...at(h, m), repeat: "daily" };
	if (dom === "*" && dow === "1-5") return { ...at(h, m), repeat: "weekdays" };
	if (dom === "*") {
		const d = num(dow);
		return d === null || d > 6
			? null
			: { ...at(h, m), repeat: "weekly", weekday: d };
	}
	if (dow === "*") {
		const d = num(dom);
		return d === null || d < 1 || d > 28
			? null
			: { ...at(h, m), repeat: "monthly", day: d };
	}
	return null;
}

const DAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

/** 1st, 2nd, 3rd, 11th, 21st — for "on the Nth". */
export function ordinal(n: number): string {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * The schedule in words. A cron the picker can't express is returned as
 * written — saying something vague about it would be worse than the cron.
 */
export function describeCron(expr: string): string {
	const s = scheduleOf(expr);
	if (!s) return expr.trim();
	switch (s.repeat) {
		case "15m":
			return "every 15 minutes";
		case "30m":
			return "every 30 minutes";
		case "hourly":
			return "every hour, on the hour";
		case "daily":
			return `every day at ${s.time}`;
		case "weekdays":
			return `weekdays at ${s.time}`;
		case "weekly":
			return `every ${DAYS[s.weekday]} at ${s.time}`;
		case "monthly":
			return `on the ${ordinal(s.day)} at ${s.time}`;
	}
}

/** Sunday-first, matching cron's own numbering — for the weekday picker. */
export const WEEKDAY_NAMES = DAYS;
