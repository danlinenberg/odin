import { toast } from "@odin/ui/sonner";
import { useMemo } from "react";
import { type DoneRow, doneChecker, useDoneStore } from "renderer/stores/done";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useReminders } from "../components/Reminders";
import { useBacklogReview } from "./useBacklogReview";
import { useSetSlackDone } from "./useOdinFeeds";
import { useOdinProfile } from "./useOdinProfile";
import { useOdinTasks } from "./useOdinTasks";
import { usePaneMeta } from "./usePaneMeta";

/** What Done needs off a row: its All-feed key, and enough to list it later. */
export interface Doable {
	key: string;
	title: string;
	source: string;
	url?: string | null;
}

/**
 * A session's Done: kill its PTY and take it off the board. Session History
 * resumes it from Claude's transcript on disk.
 */
export function endSession(paneId: string) {
	const pane = useTabsStore.getState().panes[paneId];
	useTabsStore.getState().removePane(paneId);
	usePaneMeta.getState().forgetPane(paneId, pane?.claudeSessionId);
	useReminders.getState().clear(`session:${paneId}`);
}

/**
 * Done - the one way a row leaves a feed. From any feed, Next in line or a
 * Review drop, it's the same list, so a row put away in one place is gone
 * from all of them, and All tasks' Done list can bring it back.
 */
export function useDone() {
	const done = useDoneStore((s) => s.done);
	const setDone = useDoneStore((s) => s.setDone);
	const { activeId } = useOdinProfile();
	const slackDone = useSetSlackDone();
	const isDone = useMemo(() => doneChecker(done), [done]);

	const mark = (
		item: Doable,
		on: boolean,
		reading = false,
		deleted = false,
	) => {
		setDone(
			item.key,
			on
				? {
						title: item.title,
						source: item.source,
						url: item.url ?? null,
						...(reading && { reading }),
						...(deleted && { deleted }),
					}
				: null,
		);
		// Slack has a Done of its own (Odin-only, shared with the Slack feed).
		if (item.key.startsWith("slack:"))
			slackDone.mutate({ id: item.key.slice("slack:".length), done: on });
		// A Review drop undone goes back among the rows still to decide.
		if (!on) useBacklogReview.getState().unnoteDropped(activeId, item.key);
	};

	// Newest first. Reading material is a Done that isn't finished: off every
	// queue the same way, listed apart. A deleted row is listed nowhere.
	const rows = useMemo(
		() =>
			Object.entries(done)
				.filter(([, row]) => !row.deleted)
				.map(([key, row]): DoneRow & { key: string } => ({ key, ...row }))
				.sort((a, b) => b.at - a.at),
		[done],
	);

	return {
		isDone,
		recent: useMemo(() => rows.filter((row) => !row.reading), [rows]),
		reading: useMemo(() => rows.filter((row) => row.reading), [rows]),
		markReading: (item: Doable) => {
			mark(item, true, true);
			toast.success(`Reading material - ${item.title.slice(0, 60)}`, {
				action: { label: "Undo", onClick: () => mark(item, false) },
			});
		},
		markDone: (item: Doable) => {
			mark(item, true);
			toast.success(`Done - ${item.title.slice(0, 60)}`, {
				action: { label: "Undo", onClick: () => mark(item, false) },
			});
		},
		/**
		 * Gone from every view, the Done list included. One of my own tasks is
		 * removed outright; a Slack, Jira or other source row stays put away
		 * for good. Undo on the toast brings either back.
		 */
		remove: (item: Doable) => {
			const label = `Deleted - ${item.title.slice(0, 60)}`;
			if (item.key.startsWith("task:")) {
				const id = item.key.slice("task:".length);
				const tasks = useOdinTasks.getState();
				const task = tasks.tasks.find((t) => t.id === id);
				tasks.remove(id);
				setDone(item.key, null);
				toast.success(label, {
					action: {
						label: "Undo",
						onClick: () =>
							task &&
							useOdinTasks.setState((s) => ({ tasks: [task, ...s.tasks] })),
					},
				});
				return;
			}
			mark(item, true, false, true);
			toast.success(label, {
				action: { label: "Undo", onClick: () => mark(item, false) },
			});
		},
		undo: (item: Doable) => mark(item, false),
		/** Done without a toast - for a caller that shows its own. */
		set: mark,
	};
}
