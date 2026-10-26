import type { NightLogEntry } from "renderer/stores/next-in-line-prompt";

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
