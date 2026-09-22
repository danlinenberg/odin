import { cn } from "@odin/ui/utils";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * A day I want a row done by — a ticket I promised for Thursday, a thread that
 * has to be answered before the release. The feeds are read-only mirrors of
 * other people's systems, so the date is Odin-local, like hiding: a persisted
 * map from the same `feed:id` key, to the day it's wanted.
 */
export interface Reminder {
	/** Local calendar day, `YYYY-MM-DD` — what `<input type="date">` hands back. */
	due: string;
	/** Kept with the date so a reminder can name its row without its feed. */
	title: string;
}

export const useReminders = create<{
	reminders: Record<string, Reminder>;
	/** The day each key last pinged — a due date nags once a day, not every minute. */
	notified: Record<string, string>;
	setDue: (key: string, due: string, title: string) => void;
	clear: (key: string) => void;
	markNotified: (key: string, day: string) => void;
}>()(
	persist(
		(set) => ({
			reminders: {},
			notified: {},
			setDue: (key, due, title) =>
				set((s) => ({
					reminders: { ...s.reminders, [key]: { due, title } },
					// Moving the date arms it again: pushed to Friday, it pings Friday.
					notified: { ...s.notified, [key]: "" },
				})),
			clear: (key) =>
				set((s) => {
					const { [key]: _due, ...reminders } = s.reminders;
					const { [key]: _seen, ...notified } = s.notified;
					return { reminders, notified };
				}),
			markNotified: (key, day) =>
				set((s) => ({ notified: { ...s.notified, [key]: day } })),
		}),
		{ name: "odin-reminders" },
	),
);

/**
 * `YYYY-MM-DD` for a moment, in the local zone — the form the date input
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
	return localDay(due).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

/** Due today or already past, and not pinged yet today. */
export function dueToFire(
	reminders: Record<string, Reminder>,
	notified: Record<string, string>,
	now: number,
): string[] {
	const today = dayOf(now);
	// Both sides are zero-padded `YYYY-MM-DD`, so string order is date order.
	return Object.keys(reminders).filter(
		(key) => (reminders[key]?.due ?? "") <= today && notified[key] !== today,
	);
}

/** Whether a row is due today or overdue — what the pill counts and filters on. */
export function isDue(
	key: string,
	reminders: Record<string, Reminder>,
	now: number,
): boolean {
	const due = reminders[key]?.due;
	return due !== undefined && due <= dayOf(now);
}

const TONE_CLASS: Record<DueTone, string> = {
	overdue: "bg-[#3a1c1c] text-[#ff8a8a]",
	today: "bg-[#221d12] text-[#f5b83d]",
	soon: "bg-[#1f1f27] text-[#a5a5b3]",
	later: "bg-[#1f1f27] text-[#8a8a97]",
};

/** The due column, the same width in every feed that shows one. */
export const META_DUE = "flex w-[92px] shrink-0 items-center justify-end gap-1";

/**
 * Set, move or drop a row's due date. The chip opens the OS date picker — the
 * native input is there, just not its box: a feed row is a line of text, and a
 * `mm/dd/yyyy` control on every one of them is a form.
 */
export function DueChip({
	itemKey,
	title,
}: {
	itemKey: string;
	title: string;
}) {
	const reminder = useReminders((s) => s.reminders[itemKey]);
	const setDue = useReminders((s) => s.setDue);
	const clear = useReminders((s) => s.clear);
	const input = useRef<HTMLInputElement>(null);
	const now = Date.now();
	return (
		<>
			<input
				ref={input}
				type="date"
				value={reminder?.due ?? ""}
				onChange={(e) =>
					e.target.value
						? setDue(itemKey, e.target.value, title)
						: clear(itemKey)
				}
				tabIndex={-1}
				aria-hidden
				className="pointer-events-none absolute size-0 opacity-0"
			/>
			<button
				type="button"
				title={reminder ? `Due ${reminder.due}` : "Set a due date"}
				// A board card is itself a button — without this, dating a session
				// opens its drawer.
				onClick={(e) => {
					e.stopPropagation();
					input.current?.showPicker();
				}}
				className={cn(
					"truncate rounded-[5px] px-[7px] py-[1px] text-[11px] font-semibold transition-colors",
					reminder
						? TONE_CLASS[dueTone(reminder.due, now)]
						: "text-[#8a8a97] opacity-0 hover:text-[#f5f5f7] group-hover:opacity-100",
				)}
			>
				{reminder ? dueLabel(reminder.due, now) : "+ due"}
			</button>
			{reminder && (
				<button
					type="button"
					title="Drop the due date"
					onClick={(e) => {
						e.stopPropagation();
						clear(itemKey);
					}}
					className="text-[11px] text-[#8a8a97] opacity-0 transition-opacity hover:text-[#f5f5f7] group-hover:opacity-100"
				>
					✕
				</button>
			)}
		</>
	);
}

/**
 * Ping for anything due, on launch and every minute after — so a date set for
 * Thursday says so on Thursday whether or not the feed that set it is open.
 * Once a day per row, and again each day it stays overdue, which is the whole
 * point of having written the date down.
 *
 * ponytail: a reminder on a row that's since been closed upstream keeps
 * pinging until it's cleared — join against the live feeds here if that turns
 * into a nuisance.
 */
export function useDueReminders(): void {
	useEffect(() => {
		const tick = () => {
			const { reminders, notified, markNotified } = useReminders.getState();
			const now = Date.now();
			const today = dayOf(now);
			for (const key of dueToFire(reminders, notified, now)) {
				const reminder = reminders[key];
				if (!reminder) continue;
				new Notification(
					reminder.due < today ? "Overdue in Odin" : "Due today in Odin",
					{ body: reminder.title },
				);
				markNotified(key, today);
			}
		};
		tick();
		const id = setInterval(tick, 60_000);
		return () => clearInterval(id);
	}, []);
}
