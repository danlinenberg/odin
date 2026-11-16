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
}

export type HostLink = "connecting" | "connected" | "lost";

export const useHostView = create<HostViewState>()(() => ({
	byPane: {},
	open: null,
	link: {},
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
	useHostView.setState((state) => ({
		byPane: { ...state.byPane, [paneId]: screen },
		open: paneId,
	}));
}

export const closeHostScreen = () => useHostView.setState({ open: null });
