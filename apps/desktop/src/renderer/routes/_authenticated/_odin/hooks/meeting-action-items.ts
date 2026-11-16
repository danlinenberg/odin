import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Meeting } from "../all/all-items";
import { useTaskMeta } from "../all/task-meta";
import { useOdinTasks } from "./useOdinTasks";

/**
 * Meetings you write action items after. Right-click a Calendar row to mark
 * it; when a marked meeting ends, Odin adds "Write action items: <title>" to
 * Tasks, on top of Up next. Marking holds for the whole series: a meeting's id
 * is `<uid>@<start>` and every occurrence shares the uid.
 */

/** A meeting seen in the feed and marked, waiting to end. */
interface Pending {
	title: string;
	end: string;
	attendees: string[];
}

/** The series a meeting id belongs to: the id minus its `@<start>`. */
export const seriesOf = (meetingId: string): string =>
	meetingId.slice(0, meetingId.lastIndexOf("@"));

/**
 * Split marked meetings into the ones that ended (time to add a task) and the
 * ones still to come. `pending` remembers marked meetings the feed showed
 * earlier: the feed only reads from now on, so a meeting is gone from it by
 * the time it ends, and Odin may have been closed when it did.
 */
export function actionItemsDue(
	meetings: Meeting[],
	series: Record<string, string>,
	pending: Record<string, Pending>,
	now: number,
): { ready: Pending[]; pending: Record<string, Pending> } {
	const next: Record<string, Pending> = {};
	for (const [id, meeting] of Object.entries(pending))
		if (series[seriesOf(id)] !== undefined) next[id] = meeting;
	for (const meeting of meetings)
		if (series[seriesOf(meeting.id)] !== undefined)
			next[meeting.id] = {
				title: meeting.title,
				end: meeting.end,
				attendees: meeting.attendees,
			};
	const ready: Pending[] = [];
	for (const [id, meeting] of Object.entries(next)) {
		if (Date.parse(meeting.end) > now) continue;
		ready.push(meeting);
		delete next[id];
	}
	return { ready, pending: next };
}

/** The task's text: its title, then notes saying which meeting and with whom. */
export function actionItemsTask(meeting: Pending): string {
	const ended = new Date(meeting.end).toLocaleString(undefined, {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
	return [
		`Write action items: ${meeting.title}`,
		`The meeting ended ${ended}.`,
		meeting.attendees.length > 0 && `With: ${meeting.attendees.join(", ")}`,
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Bounded by what you mark (one entry per series) and by the meetings in the
 * feed's two-day window; an entry leaves when its task is added or its series
 * is unmarked.
 */
export const useMeetingActionItems = create<{
	/** Marked series: uid -> the title it was marked under. */
	series: Record<string, string>;
	pending: Record<string, Pending>;
	toggle: (meetingId: string, title: string) => void;
	setPending: (pending: Record<string, Pending>) => void;
}>()(
	persist(
		(set) => ({
			series: {},
			pending: {},
			toggle: (meetingId, title) =>
				set((s) => {
					const key = seriesOf(meetingId);
					const series = { ...s.series };
					if (series[key] !== undefined) delete series[key];
					else series[key] = title;
					return { series };
				}),
			setPending: (pending) => set({ pending }),
		}),
		{ name: "odin-meeting-action-items" },
	),
);

/**
 * Every minute, and whenever the feed reloads: add the action-items task for
 * each marked meeting that ended, to the active profile, on top of Up next.
 */
export function useMeetingActionItemsRunner(
	meetings: Meeting[] | undefined,
	profileId: string,
	ready: boolean,
) {
	useEffect(() => {
		if (!ready) return;
		const tick = () => {
			const store = useMeetingActionItems.getState();
			const due = actionItemsDue(
				meetings ?? [],
				store.series,
				store.pending,
				Date.now(),
			);
			store.setPending(due.pending);
			for (const meeting of due.ready) {
				const id = useOdinTasks
					.getState()
					.add(actionItemsTask(meeting), profileId);
				if (id) useTaskMeta.getState().enqueueAt(`task:${id}`, "top");
			}
		};
		tick();
		const timer = setInterval(tick, 60_000);
		return () => clearInterval(timer);
	}, [meetings, profileId, ready]);
}
