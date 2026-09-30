import { toast } from "@odin/ui/sonner";
import type { ReactionRow } from "lib/trpc/routers/slack";
import { useEffect, useRef } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { buildThreadPrompt } from "../thread-prompt";
import { useOdinFeeds } from "./useOdinFeeds";
import { useOdinWorkspace } from "./useOdinWorkspace";
import { usePaneMeta } from "./usePaneMeta";

/**
 * Start a session on a queued Slack message — the Reactions page's Start
 * button and the :robot_face: auto-launcher both come through here. Resolves
 * to the new pane id, or null after toasting why it couldn't start.
 */
export function useStartReaction() {
	const { reactions } = useOdinFeeds();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const markStarted = electronTrpc.slack.markStarted.useMutation({
		onSuccess: () => void reactions.refetch(),
	});

	const start = async (row: ReactionRow): Promise<string | null> => {
		if (!row.permalink) {
			toast.error("No Slack link for this message");
			return null;
		}
		const ensured = await ensureWorkspace();
		if (!ensured.ok) {
			toast.error(ensured.error);
			return null;
		}
		const result = await launch({
			key: row.id,
			workspaceId: ensured.workspace.id,
			title: row.title,
			description: buildThreadPrompt(row.permalink, row.title, row.text),
			contact: row.authorName,
			// The whole message: the title is cut at 120 chars.
			brief: row.text || row.title,
			pageId: row.id,
			source: "reactions",
		});
		if (!result.ok) {
			toast.error(result.error);
			return null;
		}
		markStarted.mutate({ id: row.id });
		usePaneMeta.getState().setTitle(result.paneId, row.title);
		usePaneMeta.getState().setSessionId(result.paneId, result.sessionId);
		usePaneMeta.getState().setPaneForPage(row.id, result.paneId);
		return result.paneId;
	};

	return { start, isLaunching, launchingKey };
}

/**
 * Start every message I put the launch reaction on, as the poll finds them.
 * Mounted in the Odin shell so it runs whichever view is open. Doesn't steal
 * focus: the card lands on the board and a toast says so.
 */
export function useSlackAutoLaunch(): void {
	const { reactions } = useOdinFeeds();
	const { start } = useStartReaction();
	// Once per row per app run: a failed launch toasts once instead of every poll.
	const tried = useRef(new Set<string>());
	const rows = reactions.data?.rows;

	// biome-ignore lint/correctness/useExhaustiveDependencies: start is rebuilt every render; rows is the trigger
	useEffect(() => {
		void (async () => {
			for (const row of rows ?? []) {
				// Older main process (pre-restart) doesn't send the flag at all.
				if (!row.autoLaunch || tried.current.has(row.id)) continue;
				tried.current.add(row.id);
				if (await start(row)) toast.success(`Started from Slack: ${row.title}`);
			}
		})();
	}, [rows]);
}
