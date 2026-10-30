import type { NightLogEntry } from "renderer/stores/next-in-line-prompt";
import type { AllItem } from "../all/all-items";

/** Nights a plan covers, so the host goes on that long with this computer away. */
export const PLAN_NIGHTS = 3;

/**
 * `count` windows from `first` on, each set by this computer's clock on its
 * own day, so a clock change between them comes out right on the host.
 * `windowAt(t)` is the window open at t, or the next one.
 */
export function nextWindows(
	first: { from: number; to: number },
	count: number,
	windowAt: (at: Date) => { from: number; to: number },
): { from: number; to: number }[] {
	const out = [first];
	while (out.length < count) {
		const last = out[out.length - 1] as { from: number; to: number };
		out.push(windowAt(new Date(last.to * 1000 + 1000)));
	}
	return out;
}

/** Keys the host must never start: done here, or started on any host already. */
export function nightExclude(
	doneKeys: string[],
	log: NightLogEntry[],
): string[] {
	const started = log.flatMap((entry) =>
		entry.started ? [entry.started.key] : [],
	);
	return [...new Set([...doneKeys, ...started])];
}

/**
 * A board row for a Slack message the host picked itself while this
 * computer was away, so its session lands on the board with no row of ours
 * behind it. Null for anything else.
 */
export function hostPickedItem(run: {
	key: string;
	title: string;
	url?: string;
	at: number;
}): AllItem | null {
	if (!run.key.startsWith("slack:") || !run.url) return null;
	const id = run.key.slice("slack:".length);
	const at = run.at * 1000;
	return {
		key: run.key,
		source: "Slack",
		to: "/reactions",
		title: run.title,
		url: run.url,
		person: null,
		status: null,
		context: null,
		priority: "High",
		urgency: "high",
		at,
		createdAt: at,
		dueDate: null,
		mention: null,
		ask: { kind: "asked", at },
		body: null,
		details: [],
		launch: {
			key: id,
			title: run.title,
			description: run.url,
			contact: null,
			brief: run.title,
			pageId: id,
			source: "reactions",
		},
	};
}

/** A plan send that failed, and when the runner tries it again. */
export interface SendFailure {
	error: string;
	attempts: number;
	nextAt: number;
}

const MINUTE_MS = 60_000;

/** The wait before the next try: a minute, doubling, at most 15 minutes. */
export function retryDelayMs(attempts: number): number {
	return Math.min(MINUTE_MS * 2 ** Math.max(0, attempts - 1), 15 * MINUTE_MS);
}

/** How long before the window an unsent plan raises a notification. */
export const ALERT_BEFORE_MS = 60 * MINUTE_MS;

/**
 * Whether to raise the notification now, while a send is failing: the host has no
 * plan for the coming window, it opens within the hour (or already has), and
 * this night was not alerted yet.
 */
export function shouldAlert(input: {
	now: number;
	windowFrom: number;
	hasPlan: boolean;
	alertedFor: number | null;
}): boolean {
	return (
		!input.hasPlan &&
		input.now >= input.windowFrom - ALERT_BEFORE_MS &&
		input.alertedFor !== input.windowFrom
	);
}

const MISSED = "window opened on";

/** The log line for a window that opened on the host with no plan for it. */
export function missedLine(
	span: string,
	name: string,
	error: string | null,
): string {
	return `The ${span} ${MISSED} ${name} with no plan for that night, so it started nothing when it opened.${error ? ` The last send failed: ${error}` : ""}`;
}

/**
 * Whether the log already says the window of `night` (ms) opened with no
 * plan. The host and this computer can each report it, an hour apart across
 * a clock change, so a line within two hours counts.
 */
export function missedLogged(log: NightLogEntry[], night: number): boolean {
	return log.some(
		(entry) =>
			entry.night !== undefined &&
			Math.abs(entry.night - night) < 2 * ALERT_BEFORE_MS &&
			entry.event.includes(MISSED),
	);
}
