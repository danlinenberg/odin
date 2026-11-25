import { useDangerMode, useOpenChats } from "renderer/stores/danger-mode";
import { useTabsStore } from "renderer/stores/tabs/store";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { ChatView } from "./ChatView";

/**
 * GSD Mode for sessions whose chat isn't on screen: their `!` commands run,
 * their menus get answered and Claude is told to carry on, on any page, with
 * nobody watching. A session's open chat does that itself, so it is skipped.
 */
export function GsdBackground() {
	const on = useDangerMode((state) => state.on);
	const open = useOpenChats((state) => state.count);
	const ids = Object.keys(on).filter((paneId) => !open[paneId]);
	return (
		<>
			{ids.map((paneId) => (
				<GsdRunner key={paneId} paneId={paneId} />
			))}
		</>
	);
}

function GsdRunner({ paneId }: { paneId: string }) {
	const pane = useTabsStore((state) => state.panes[paneId]);
	const workspaceId = useTabsStore(
		(state) => state.tabs.find((tab) => tab.id === pane?.tabId)?.workspaceId,
	);
	const metaSessionId = usePaneMeta((state) => state.sessionIdByPane[paneId]);
	const sessionId = pane?.claudeSessionId ?? metaSessionId ?? null;
	if (!pane || !workspaceId || !sessionId) return null;
	return (
		<ChatView
			headless
			paneId={paneId}
			sessionId={sessionId}
			cwd={pane.cwd ?? pane.initialCwd ?? pane.odinCwd ?? undefined}
			workspaceId={workspaceId}
			working={pane.status === "working"}
			onShowTerminal={() => {}}
		/>
	);
}
