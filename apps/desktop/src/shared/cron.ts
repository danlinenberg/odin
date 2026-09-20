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
