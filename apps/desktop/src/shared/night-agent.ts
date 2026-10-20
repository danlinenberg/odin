/*
 * The Night Agent's settings and window. Shared so the window and a remote
 * server's Night Agent (main/odin-core/scheduler) read them the same way.
 */

export interface OffHours {
	enabled: boolean;
	/** "HH:MM", local time. A start after the end wraps past midnight. */
	start: string;
	end: string;
	/** A ceiling on one night's sessions, so a bad night can't burn the quota. */
	maxSessions: number;
	/** Appended to every Night Agent task's prompt. */
	instructions: string;
	/** Rows you picked for the night, in start order. They run before anything ranked. */
	picked: string[];
	/** Once tonight's picks are started: stop there, or go on with the ranked queue. */
	afterPicks: "stop" | "ranked";
	/** Whether the first-use notice (keeps the computer awake, power only) was shown. */
	introSeen: boolean;
}

/** One line of what the Night Agent did or why it didn't, for Huginn and you. */
export interface NightLogEntry {
	/** ISO time. */
	at: string;
	event: string;
}

export const DEFAULT_OFF_HOURS: OffHours = {
	enabled: false,
	start: "23:00",
	end: "07:00",
	maxSessions: 8,
	picked: [],
	afterPicks: "stop",
	introSeen: false,
	instructions:
		"This is a Night Agent run: I'm asleep and will read the result in the morning. Get it as far as you can on your own - investigate, find the root cause, and make and verify the change on a branch with a PR open. Don't do anything other people would see before I've looked: no Slack or email messages, no Jira or PR comments, no merging, no deploys. Leave those in ACTION ITEMS.",
};

/** Whether `now` falls in the window - `end` exclusive, wrapping midnight. */
export function inOffHours(now: Date, start: string, end: string): boolean {
	const minutes = (hhmm: string) => {
		const [h = 0, m = 0] = hhmm.split(":").map(Number);
		return h * 60 + m;
	};
	const t = now.getHours() * 60 + now.getMinutes();
	const [s, e] = [minutes(start), minutes(end)];
	return s <= e ? t >= s && t < e : t >= s || t < e;
}

/** Your sort words plus the Night Agent ones - what the night ranking obeys. */
export function nightInstructions(sort: string, offHours: string): string {
	return [
		sort,
		offHours &&
			`For the overnight run, which starts these one by one while I'm away:\n${offHours}`,
	]
		.filter(Boolean)
		.join("\n\n");
}
