import { toast } from "@odin/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useOdinWorkspace } from "./useOdinWorkspace";
import { usePendingFocus } from "./usePendingFocus";

/** A finished conversation, as Session History and Docs know it. */
export interface ResumableSession {
	sessionId: string;
	/** Where it ran. Null when the transcript never recorded one. */
	cwd: string | null;
	title: string;
	/** Its opening prompt, which seeds the new card's brief. */
	prompt?: string | null;
}

/**
 * Resume a finished session: a fresh pane running `claude --resume <id>` in
 * the session's own directory (its original pane is long gone), then over to
 * the board where every live session lives, with its drawer open.
 *
 * Shared by Session History and the Docs page's Back to board.
 */
export function useResumeSession() {
	const navigate = useNavigate();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching } = useLaunchTaskSession();

	const resume = async (row: ResumableSession): Promise<boolean> => {
		if (!row.cwd) {
			toast.error(
				"This transcript has no recorded directory - can't resume it",
			);
			return false;
		}
		await electronTrpcClient.repos.reviveSessionWorktree.mutate({
			path: row.cwd,
		});
		const ensured = await ensureWorkspace(row.cwd);
		if (!ensured.ok) {
			toast.error(ensured.error);
			return false;
		}
		const result = await launch({
			workspaceId: ensured.workspace.id,
			title: row.title,
			description: null,
			resumeSessionId: row.sessionId,
			// `claude --resume <id>` only finds the conversation from the directory
			// it ran in, and the workspace is the repo root - a session that ran in
			// a worktree or a subdirectory resumed into "No conversation found".
			repoPath: row.cwd,
			brief: row.prompt ?? null,
		});
		if (!result.ok) {
			toast.error(result.error);
			return false;
		}
		usePendingFocus.getState().focus(result.paneId);
		toast.success(`Resuming "${row.title}"`);
		void navigate({ to: "/board" });
		return true;
	};

	return { resume, isLaunching };
}
