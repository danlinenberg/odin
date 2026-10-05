import { cn } from "@odin/ui/utils";
import { useEffect, useRef } from "react";
import { LuCalendarX } from "react-icons/lu";
import { DEFAULT_PROFILE_ID } from "shared/odin-profile";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PILL } from "./pill";

/**
 * A day I want a row done by - a ticket I promised for Thursday, a thread that
 * has to be answered before the release. The feeds are read-only mirrors of
 * other people's systems, so the date is Odin-local, like hiding: a persisted
 * map from the same `feed:id` key, to the day it's wanted.
 */
export interface Reminder {
	/** Local calendar day, `YYYY-MM-DD` - what `<input type="date">` hands back. */
	due: string;
	/** Kept with the date so a reminder can name its row without its feed. */
	title: string;
	/** Set by "Remind me" on a board session: what to resume when it's due. */
	resume?: {
		sessionId: string;
		cwd: string;
		/** The card's brief when you snoozed it - what the hover shows. */
		brief?: string;
		/** When you hit Remind me, epoch ms. */
		setAt?: number;
	};
}

interface ProfileReminders {
	reminders: Record<string, Reminder>;
	notified: Record<string, string>;
}

/** `reminders`/`notified` replaced, and filed under the profile they belong to. */
function writeActive(
	s: { profileId: string | null; byProfile: Record<string, ProfileReminders> },
	slice: ProfileReminders,
) {
	const id = s.profileId ?? DEFAULT_PROFILE_ID;
	return { ...slice, byProfile: { ...s.byProfile, [id]: slice } };
}

/**
 * Reminders are per profile: a Work meeting has no business nagging on the
 * Private board. `reminders` and `notified` are the active profile's slice -
 * empty until `setProfile` says which one that is - so readers stay plain
 * `s.reminders`; every write goes through `writeActive` to land in `byProfile`.
 */
export const useReminders = create<{
	profileId: string | null;
	byProfile: Record<string, ProfileReminders>;
	reminders: Record<string, Reminder>;
	/** The day each key last pinged - a due date nags once a day, not every minute. */
	notified: Record<string, string>;
	/** Local `HH:MM` the day's pings wait for - Settings → Notifications. */
	notifyAt: string;
	setProfile: (profileId: string) => void;
	setNotifyAt: (notifyAt: string) => void;
	setDue: (key: string, due: string, title: string) => void;
	setReminder: (key: string, reminder: Reminder) => void;
	clear: (key: string) => void;
	markNotified: (key: string, day: string) => void;
}>()(
	persist(
		(set) => ({
			profileId: null,
			byProfile: {},
			reminders: {},
			notified: {},
			notifyAt: "09:00",
			setProfile: (profileId) =>
				set((s) => ({
					profileId,
					reminders: s.byProfile[profileId]?.reminders ?? {},
					notified: s.byProfile[profileId]?.notified ?? {},
				})),
			setNotifyAt: (notifyAt) => set({ notifyAt }),
			setDue: (key, due, title) =>
				set((s) =>
					writeActive(s, {
						reminders: { ...s.reminders, [key]: { due, title } },
						// Moving the date arms it again: pushed to Friday, it pings Friday.
						notified: { ...s.notified, [key]: "" },
					}),
				),
			setReminder: (key, reminder) =>
				set((s) =>
					writeActive(s, {
						reminders: { ...s.reminders, [key]: reminder },
						notified: { ...s.notified, [key]: "" },
					}),
				),
			clear: (key) =>
				set((s) => {
					const { [key]: _due, ...reminders } = s.reminders;
					const { [key]: _seen, ...notified } = s.notified;
					return writeActive(s, { reminders, notified });
				}),
			markNotified: (key, day) =>
				set((s) =>
					writeActive(s, {
						reminders: s.reminders,
						notified: { ...s.notified, [key]: day },
					}),
				),
		}),
		{
			name: "odin-reminders",
			version: 1,
			// The view is derived from `byProfile` once the profile is known.
			partialize: (s) => ({ byProfile: s.byProfile, notifyAt: s.notifyAt }),
			// v0 was one global set: it was made under the default profile.
			migrate: (persisted, version) => {
				if (version >= 1) return persisted as never;
				const old = persisted as Partial<ProfileReminders> & {
					notifyAt?: string;
				};
				return {
					notifyAt: old.notifyAt ?? "09:00",
					byProfile: {
						[DEFAULT_PROFILE_ID]: {
							reminders: old.reminders ?? {},
							notified: old.notified ?? {},
						},
					},
				} as never;
			},
		},
	),
);

/**
 * `YYYY-MM-DD` for a moment, in the local zone - the form the date input
 * speaks. Not `toISOString()`: that one is UTC, which is already tomorrow for
 * the last hours of every day here, so "due today" would fire a day early.
 */
export function dayOf(now: number): string {
	const d = new Date(now);
	return [
		d.getFullYear(),
		String(d.getMonth() + 1).padStart(2, "0"),
		String(d.getDate()).padStart(2, "0"),
	].join("-");
}

/** The input's value as a local Date, rather than the UTC one `new Date(iso)` gives. */
function localDay(due: string): Date {
	const [y = 0, m = 1, d = 1] = due.split("-").map(Number);
	return new Date(y, m - 1, d);
}

/** Whole calendar days from today to `due`. Negative is overdue. */
export function daysUntil(due: string, now: number): number {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	// Round, not floor: a DST boundary between the two makes one day 23 or 25 hours.
	return Math.round((localDay(due).getTime() - today.getTime()) / 86_400_000);
}

export type DueTone = "overdue" | "today" | "soon" | "later";

export function dueTone(due: string, now: number): DueTone {
	const days = daysUntil(due, now);
	if (days < 0) return "overdue";
	if (days === 0) return "today";
	return days <= 2 ? "soon" : "later";
}

export function dueLabel(due: string, now: number): string {
	const days = daysUntil(due, now);
	if (days === -1) return "Yesterday";
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	// The year only when it isn't this one: a stale ticket's "Oct 5" from last
	// year otherwise reads as next week.
	const day = localDay(due);
	return day.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year:
			day.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
	});
}

/** `HH:MM` for a moment, local - the form `<input type="time">` speaks. */
function timeOf(now: number): string {
	const d = new Date(now);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Due today or already past, not pinged yet today, and the clock is past
 * `notifyAt` - so a reminder for Thursday waits for Thursday 09:00, not 00:01.
 */
export function dueToFire(
	reminders: Record<string, Reminder>,
	notified: Record<string, string>,
	now: number,
	notifyAt = "00:00",
): string[] {
	if (timeOf(now) < notifyAt) return [];
	const today = dayOf(now);
	// Both sides are zero-padded `YYYY-MM-DD`, so string order is date order.
	return Object.keys(reminders).filter(
		(key) => (reminders[key]?.due ?? "") <= today && notified[key] !== today,
	);
}

/** Whether a date is today or past - what the pill counts and filters on. */
export function isDue(due: string | null | undefined, now: number): boolean {
	return !!due && due <= dayOf(now);
}

/**
 * The date a row actually carries. Jira keeps a Due Date of its own, so a
 * dated ticket arrives already dated; Odin's is an overwrite of that, held
 * here and never written back. Drop the local one and the ticket's own date
 * comes back - Odin can move a deadline, not delete someone else's.
 */
export function effectiveDue(
	key: string,
	reminders: Record<string, Reminder>,
	upstream?: string | null,
): string | null {
	return reminders[key]?.due ?? upstream ?? null;
}

/** A date a source brought with it, ready to be merged under the overrides. */
export interface UpstreamDue {
	key: string;
	due: string;
	title: string;
}

/**
 * Upstream dates with the local overrides laid over them - what the ping
 * actually runs on, so a Jira deadline nobody retyped into Odin still speaks.
 */
export function mergeUpstream(
	reminders: Record<string, Reminder>,
	upstream: UpstreamDue[],
): Record<string, Reminder> {
	const merged: Record<string, Reminder> = {};
	for (const row of upstream)
		merged[row.key] = { due: row.due, title: row.title };
	return { ...merged, ...reminders };
}

const TONE_CLASS: Record<DueTone, string> = {
	overdue: PILL.alarm,
	today: PILL.attention,
	soon: "bg-secondary text-muted-foreground",
	later: "bg-secondary text-muted-foreground",
};

/**
 * The mark an overdue row wears beside its title - its own icon, the way a
 * starred card wears ★, so a missed deadline reads without finding the chip.
 */
export function OverdueMark({
	itemKey,
	upstream,
}: {
	itemKey: string;
	upstream?: string | null;
}) {
	const due = useReminders((s) => s.reminders[itemKey]?.due) ?? upstream;
	if (!due || dueTone(due, Date.now()) !== "overdue") return null;
	return (
		<LuCalendarX
			title={`Overdue - was due ${due}`}
			className="mr-1 inline size-3.5 align-[-2px] text-danger"
		/>
	);
}

/** The due column, the same width in every feed that shows one. */
export const META_DUE = "flex w-[92px] shrink-0 items-center justify-end";

/**
 * Set, move or drop a row's due date. The chip opens the OS date picker - the
 * native input is there, just not its box: a feed row is a line of text, and a
 * `mm/dd/yyyy` control on every one of them is a form.
 *
 * `upstream` is the date the row arrived with (Jira's own Due Date). It shows
 * through until you set one here, and comes back when you drop yours.
 */
export function DueChip({
	itemKey,
	title,
	upstream,
}: {
	itemKey: string;
	title: string;
	upstream?: string | null;
}) {
	const reminder = useReminders((s) => s.reminders[itemKey]);
	const setDue = useReminders((s) => s.setDue);
	const clear = useReminders((s) => s.clear);
	const input = useRef<HTMLInputElement>(null);
	const now = Date.now();
	const due = reminder?.due ?? upstream ?? null;
	return (
		// Positioned, so the picker opens under the chip rather than at the
		// corner of whatever card or row happens to be the nearest ancestor.
		<span className="relative inline-flex items-center gap-1">
			<input
				ref={input}
				type="date"
				value={due ?? ""}
				onChange={(e) =>
					e.target.value
						? setDue(itemKey, e.target.value, title)
						: clear(itemKey)
				}
				tabIndex={-1}
				aria-hidden
				// Chromium draws the calendar popup in the element's own colour
				// scheme, and the app is dark whatever the OS is set to.
				style={{ colorScheme: "dark" }}
				className="pointer-events-none absolute inset-0 size-full opacity-0"
			/>
			<button
				type="button"
				title={
					reminder
						? `Due ${reminder.due} - set in Odin`
						: upstream
							? `Due ${upstream} - from Jira. Setting one here overrides it in Odin only.`
							: "Set a due date"
				}
				// A board card is itself a button - without this, dating a session
				// opens its drawer.
				onClick={(e) => {
					e.stopPropagation();
					input.current?.showPicker();
				}}
				className={cn(
					"truncate rounded-[5px] px-[7px] py-[1px] text-[11px] transition-colors",
					due
						? TONE_CLASS[dueTone(due, now)]
						: "text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100",
					// An inherited date is lighter than one you chose: the ticket
					// says so, you didn't.
					reminder ? "font-semibold" : "font-medium",
				)}
			>
				{/* Spelled out: beside a card's age chip, a bare "Sep 25" could be
				    either one. */}
				{due ? `Due ${dueLabel(due, now)}` : "+ Due"}
			</button>
			{reminder && (
				<button
					type="button"
					title={
						upstream
							? `Drop yours - back to Jira's ${upstream}`
							: "Drop the due date"
					}
					onClick={(e) => {
						e.stopPropagation();
						clear(itemKey);
					}}
					className="text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
				>
					✕
				</button>
			)}
		</span>
	);
}

/**
 * Ping for anything due, on launch and every minute after - so a date set for
 * Thursday says so on Thursday whether or not the feed that set it is open.
 * Once a day per row, and again each day it stays overdue, which is the whole
 * point of having written the date down.
 *
 * ponytail: a reminder on a row that's since been closed upstream keeps
 * pinging until it's cleared - join against the live feeds here if that turns
 * into a nuisance.
 */
export function useDueReminders(upstream: UpstreamDue[]): void {
	// Read through a ref: the ping runs on a timer, not on a render, and
	// re-arming the interval every time a feed refetches would keep resetting
	// the minute it's counting.
	const latest = useRef(upstream);
	latest.current = upstream;
	useEffect(() => {
		const tick = () => {
			const { reminders, notified, notifyAt, markNotified } =
				useReminders.getState();
			const now = Date.now();
			const today = dayOf(now);
			const all = mergeUpstream(reminders, latest.current);
			const keys = dueToFire(all, notified, now, notifyAt);
			const firing = keys.flatMap((key) => all[key] ?? []);
			if (!firing.length) return;
			const [only] = firing;
			// One banner per tick, however many are due: a single one keeps its
			// own heading, several become a list.
			const note = new Notification(
				firing.length > 1
					? `${firing.length} reminders in Odin`
					: only?.resume
						? "Reminder from Odin"
						: (only?.due ?? "") < today
							? "Overdue in Odin"
							: "Due today in Odin",
				{ body: firing.map((r) => r.title).join("\n") },
			);
			// Session reminders wait on the board; bring Odin forward.
			note.onclick = () => window.focus();
			for (const key of keys) markNotified(key, today);
		};
		tick();
		const id = setInterval(tick, 60_000);
		return () => clearInterval(id);
	}, []);
}
