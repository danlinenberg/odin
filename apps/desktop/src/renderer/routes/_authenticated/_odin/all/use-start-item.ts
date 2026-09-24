import { toast } from "@odin/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useMyTasks } from "../hooks/useOdinTasks";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import type { AllItem } from "./all-items";

/**
 * Start a session on an All row, from wherever the row is shown — the All
 * feed, or the board's Next in line. `onSlackStarted` refetches whatever
 * list the Slack row should now leave.
 */
export function useStartAllItem(onSlackStarted?: () => void) {
	const navigate = useNavigate();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const { setPane } = useMyTasks();
	const panes = useTabsStore((s) => s.panes);
	// Starting a Slack row is what takes it out of the queue — the same call
	// the Slack feed makes, so a message started here doesn't come back.
	const markStarted = electronTrpc.slack.markStarted.useMutation({
		onSuccess: () => onSlackStarted?.(),
	});

	/**
	 * The pane already working this row, if there is one. Panes carry the page
	 * id for Slack/Notion and the launch title for everything else — matching
	 * both is what keeps Start session from opening a second agent on a ticket
	 * that already has one.
	 */
	const livePaneFor = (item: AllItem): string | null =>
		Object.values(panes).find(
			(pane) =>
				!pane.completed &&
				((item.launch.pageId != null &&
					pane.odinPageId === item.launch.pageId) ||
					pane.odinTaskTitle === item.launch.title),
		)?.id ?? null;

	const start = async (item: AllItem) => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const result = await launch({
			...item.launch,
			workspaceId: ensured.workspace.id,
		});
		if (!result.ok) return toast.error(result.error);
		if (item.source === "Slack") {
			markStarted.mutate({ id: item.launch.key });
			usePaneMeta.getState().setTitle(result.paneId, item.launch.title);
			usePaneMeta.getState().setSessionId(result.paneId, result.sessionId);
			usePaneMeta.getState().setPaneForPage(item.launch.key, result.paneId);
		}
		// My own tasks keep their row and gain a way into the session.
		if (item.source === "Tasks") setPane(item.launch.key, result.paneId);
		usePendingFocus.getState().focus(result.paneId);
		navigate({ to: "/board" });
	};

	return { start, livePaneFor, isLaunching, launchingKey };
}
