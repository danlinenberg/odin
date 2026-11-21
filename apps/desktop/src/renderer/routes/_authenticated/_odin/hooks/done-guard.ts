import { useTabsStore } from "renderer/stores/tabs/store";
import { create } from "zustand";
import { type AllItem, paneWorksOn } from "../all/all-items";
import { type BriefTodo, usePaneMeta } from "./usePaneMeta";

/** A session about to be Done, and what to call it in the warning. */
export interface GuardedSession {
	paneId: string;
	title: string;
}

/**
 * The sessions among `sessions` that still have an unticked to-do in My
 * notes, in the order given. A session with every to-do ticked, or none,
 * doesn't hold Done up.
 */
export function withOpenTodos(
	sessions: GuardedSession[],
	todosByPane: Record<string, readonly BriefTodo[] | undefined>,
): GuardedSession[] {
	return sessions.filter((session) =>
		(todosByPane[session.paneId] ?? []).some((todo) => !todo.done),
	);
}

/** The open sessions on a task row, titled the way the board titles them. */
export function sessionsOnRow(item: AllItem): GuardedSession[] {
	const { titleByPane } = usePaneMeta.getState();
	return Object.values(useTabsStore.getState().panes)
		.filter((pane) => paneWorksOn(pane, item))
		.map((pane) => ({
			paneId: pane.id,
			title:
				titleByPane[pane.id] ??
				pane.odinTaskTitle ??
				pane.userTitle ??
				pane.name ??
				item.title,
		}));
}

interface PendingDone {
	sessions: GuardedSession[];
	/** What is being finished: a session, a few, or a task. */
	what: string;
	proceed: () => void;
}

export const useDoneGuard = create<{
	pending: PendingDone | null;
	close: () => void;
}>()((set) => ({
	pending: null,
	close: () => set({ pending: null }),
}));

/**
 * Done, unless a session it finishes still has unticked to-dos in My notes:
 * then OpenTodosDialog lists them first, and Done anyway (or ticking them all
 * off) goes on with it. Cancel leaves everything as it was. Every Done a person
 * clicks - a card, the drawer, the right-click menu, ticked rows, a task -
 * goes through here, so the warning reads the same wherever you press it.
 */
export function guardDone(
	sessions: GuardedSession[],
	proceed: () => void,
	what = sessions.length === 1 ? "this session" : "these sessions",
): void {
	const open = withOpenTodos(sessions, usePaneMeta.getState().todosByPane);
	if (!open.length) {
		proceed();
		return;
	}
	useDoneGuard.setState({ pending: { sessions: open, what, proceed } });
}

/** guardDone for a task row: the sessions on it hold its Done up. */
export function guardTaskDone(item: AllItem, proceed: () => void): void {
	guardDone(sessionsOnRow(item), proceed, "this task");
}

/**
 * guardDone for ticked rows (the tick-box bar's Done, a ticked row's
 * right-click, Next in line's ticked cards): one warning for the lot, listing
 * every session on them with an unticked to-do.
 */
export function guardTasksDone(
	items: readonly AllItem[],
	proceed: () => void,
	sessionsOf: (item: AllItem) => GuardedSession[] = sessionsOnRow,
): void {
	guardDone(
		items.flatMap(sessionsOf),
		proceed,
		items.length === 1 ? "this task" : "these tasks",
	);
}
