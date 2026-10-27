import type { NightLogEntry } from "renderer/stores/next-in-line-prompt";
import { nightWindow } from "../hooks/useNightAgentRunner";

/** One night of the log: the window, and what the Night Agent did in it. */
export interface Night {
	/** The window's start, ms - the night's identity. */
	from: number;
	/** The window's end, ms. */
	to: number;
	/** "Tonight", "Last night", or the date it started. */
	label: string;
	/** The date it started, e.g. "Sat, Oct 18". */
	date: string;
	/** Every line of the night, newest first. */
	lines: NightLogEntry[];
	/** The sessions it started, in start order. */
	started: NightLogEntry[];
}

const DAY_MS = 86_400_000;

/** The window `at` falls in, or the next one, as ms. */
function windowAt(at: number, start: string, end: string) {
	const w = nightWindow(new Date(at), start, end);
	return { from: w.from * 1000, to: w.to * 1000 };
}

/**
 * Which night a line belongs to: the one stamped on it, else the window it
 * fell in, else - a daytime line - the nearer of the night just over and the
 * coming one. "Window closed" lands minutes after the end, or whenever the
 * computer wakes; either way the night before is the nearer.
 */
function nightOf(
	entry: NightLogEntry,
	start: string,
	end: string,
): { from: number; to: number } {
	if (entry.night) return windowAt(entry.night, start, end);
	const at = new Date(entry.at).getTime();
	const next = windowAt(at, start, end);
	if (next.from <= at) return next;
	const previous = windowAt(at - DAY_MS, start, end);
	return at - previous.to <= next.from - at ? previous : next;
}

export function nightDate(from: number): string {
	return new Date(from).toLocaleDateString([], {
		weekday: "short",
		month: "short",
		day: "numeric",
	});
}

/**
 * The log by night, newest night first. `now` says which night is tonight
 * (the window open now, or the next one) and which was last night.
 */
export function groupNights(
	log: NightLogEntry[],
	start: string,
	end: string,
	now = new Date(),
): Night[] {
	const byFrom = new Map<number, Night>();
	const tonight = windowAt(now.getTime(), start, end).from;
	const lastNight = windowAt(now.getTime() - DAY_MS, start, end).from;
	for (const entry of log) {
		const { from, to } = nightOf(entry, start, end);
		let night = byFrom.get(from);
		if (!night) {
			night = {
				from,
				to,
				label:
					from === tonight
						? "Tonight"
						: from === lastNight
							? "Last night"
							: nightDate(from),
				date: nightDate(from),
				lines: [],
				started: [],
			};
			byFrom.set(from, night);
		}
		night.lines.push(entry);
		if (entry.started) night.started.push(entry);
	}
	const time = (entry: NightLogEntry) => new Date(entry.at).getTime();
	for (const night of byFrom.values()) {
		night.lines.sort((a, b) => time(b) - time(a));
		night.started.sort((a, b) => time(a) - time(b));
	}
	return [...byFrom.values()].sort((a, b) => b.from - a.from);
}

/**
 * The night the page leads with: tonight while the window is open, else
 * last night - from the log, or empty when the log holds nothing for it.
 */
export function featuredNight(
	nights: Night[],
	start: string,
	end: string,
	now = new Date(),
): Night {
	const at = now.getTime();
	const current = windowAt(at, start, end);
	const open = current.from <= at;
	const window = open ? current : windowAt(at - DAY_MS, start, end);
	return (
		nights.find((night) => night.from === window.from) ?? {
			from: window.from,
			to: window.to,
			label: open ? "Tonight" : "Last night",
			date: nightDate(window.from),
			lines: [],
			started: [],
		}
	);
}

/** How many nights, and lines per night, the phone's page gets. */
const PHONE_NIGHTS = 7;
const PHONE_LINES = 40;

/** One night on the phone's Night Agent page. */
export interface PhoneNight {
	label: string;
	date: string;
	/** The sessions it started, in start order; paneId opens one still on the board. */
	started: {
		title: string;
		source: string;
		at: string;
		sessionId?: string;
		paneId?: string;
	}[];
	/** Every line of the night, newest first. */
	lines: { at: string; event: string }[];
}

/**
 * The newest nights, for the phone's Night Agent page. A started session's paneId is the pane still holding its
 * conversation, so the phone opens it; without one the phone resumes it.
 */
export function phoneNights(
	log: NightLogEntry[],
	window: { start: string; end: string },
	paneOf: (sessionId: string) => string | undefined,
	now = new Date(),
): PhoneNight[] {
	return groupNights(log, window.start, window.end, now)
		.slice(0, PHONE_NIGHTS)
		.map((night) => ({
			label: night.label,
			date: night.date,
			started: night.started.flatMap(({ at, started }) =>
				started
					? [
							{
								title: started.title,
								source: started.source,
								at,
								sessionId: started.sessionId,
								paneId: started.sessionId
									? paneOf(started.sessionId)
									: undefined,
							},
						]
					: [],
			),
			lines: night.lines
				.slice(0, PHONE_LINES)
				.map(({ at, event }) => ({ at, event })),
		}));
}
