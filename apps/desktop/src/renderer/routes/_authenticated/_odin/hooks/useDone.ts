import { toast } from "@odin/ui/sonner";
import { useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { type DoneRow, doneChecker, useDoneStore } from "renderer/stores/done";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useReminders } from "../components/Reminders";
import { useBacklogReview } from "./useBacklogReview";
import { useOdinProfile } from "./useOdinProfile";
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
	const slackDone = electronTrpc.slack.setDone.useMutation();
	const utils = electronTrpc.useUtils();
	const isDone = useMemo(() => doneChecker(done), [done]);

	const mark = (item: Doable, on: boolean) => {
		setDone(
			item.key,
			on
				? { title: item.title, source: item.source, url: item.url ?? null }
				: null,
		);
		// Slack has a Done of its own (Odin-only, shared with the Slack feed).
		if (item.key.startsWith("slack:"))
			slackDone.mutate(
				{ id: item.key.slice("slack:".length), done: on },
				{ onSettled: () => void utils.slack.reactions.invalidate() },
			);
		// A Review drop undone goes back among the rows still to decide.
		if (!on) useBacklogReview.getState().unnoteDropped(activeId, item.key);
	};

	return {
		isDone,
		/** Newest first, for the Done list. */
		recent: useMemo(
			() =>
				Object.entries(done)
					.map(([key, row]): DoneRow & { key: string } => ({ key, ...row }))
					.sort((a, b) => b.at - a.at),
			[done],
		),
		markDone: (item: Doable) => {
			mark(item, true);
			toast.success(`Done - ${item.title.slice(0, 60)}`, {
				action: { label: "Undo", onClick: () => mark(item, false) },
			});
		},
		undo: (item: Doable) => mark(item, false),
	};
}
