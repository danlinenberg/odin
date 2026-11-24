import { create } from "zustand";

/** A `!view <port> <password>` block: a VNC server on the session's host. */
export interface HostScreen {
	port: number;
	password: string;
}

/**
 * Each session's latest `!view` screen, which gives its drawer a View button,
 * and the session whose drawer shows it now (null: none). In memory only: a
 * viewer's server dies with its run, so a stale one is no use after a restart.
 */
interface HostViewState {
	byPane: Record<string, HostScreen>;
	open: string | null;
	/** Each open viewer's link to its host, which colors the ▣ View button's dot. */
	link: Record<string, HostLink>;
	/** Sessions whose screen shows in its own window, so the drawer holds no viewer. */
	inWindow: Record<string, true>;
}

export type HostLink = "connecting" | "connected" | "lost";

export const useHostView = create<HostViewState>()(() => ({
	byPane: {},
	open: null,
	link: {},
	inWindow: {},
}));

/** Records this session's viewer link; null when no viewer is showing it. */
export function setHostLink(paneId: string, link: HostLink | null): void {
	useHostView.setState((state) => {
		const { [paneId]: _, ...rest } = state.link;
		return { link: link ? { ...rest, [paneId]: link } : rest };
	});
}

/** Shows `screen` in this session's drawer, in the terminal's place. */
export function showHostScreen(paneId: string, screen: HostScreen): void {
	useHostView.setState((state) => {
		const { [paneId]: _, ...inWindow } = state.inWindow;
		return {
			byPane: { ...state.byPane, [paneId]: screen },
			open: paneId,
			inWindow,
		};
	});
}

/**
 * A reply this recent with a new `!view` block opens the app by itself; an
 * older one (a transcript read again after a restart) only brings the button
 * back, since its viewer is likely gone.
 */
export const FRESH_VIEW_MS = 5 * 60_000;

export const closeHostScreen = () => useHostView.setState({ open: null });

/** Shows this session's screen in the drawer again, not in its own window. */
export function openHostScreen(paneId: string): void {
	useHostView.setState((state) => {
		const { [paneId]: _, ...inWindow } = state.inWindow;
		return { open: paneId, inWindow };
	});
}

/** The screen moved to its own window: the drawer lets go of it. */
export function hostScreenToWindow(paneId: string): void {
	useHostView.setState((state) => ({
		open: state.open === paneId ? null : state.open,
		inWindow: { ...state.inWindow, [paneId]: true },
	}));
}
