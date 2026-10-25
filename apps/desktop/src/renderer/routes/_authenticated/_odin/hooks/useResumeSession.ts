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
 * the session's own directory (its original pane is long gone). The new pane's
 * id, or why it couldn't start.
 *
 * Shared by Session History, the Docs page's Back to board and the phone.
 */
export async function resumeSession(
	row: ResumableSession,
	deps: {
		ensureWorkspace: ReturnType<typeof useOdinWorkspace>["ensureWorkspace"];
		launch: ReturnType<typeof useLaunchTaskSession>["launch"];
	},
): Promise<{ ok: true; paneId: string } | { ok: false; error: string }> {
	if (!row.cwd)
		return {
			ok: false,
			error: "This transcript has no recorded directory - can't resume it",
		};
	await electronTrpcClient.repos.reviveSessionWorktree.mutate({
		path: row.cwd,
	});
	const ensured = await deps.ensureWorkspace(row.cwd);
	if (!ensured.ok) return { ok: false, error: ensured.error };
	const result = await deps.launch({
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
	return result.ok
		? { ok: true, paneId: result.paneId }
		: { ok: false, error: result.error };
}

/**
 * Resume a finished session, then over to the board where every live session
 * lives, with its drawer open.
 */
export function useResumeSession() {
	const navigate = useNavigate();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching } = useLaunchTaskSession();

	const resume = async (row: ResumableSession): Promise<boolean> => {
		const result = await resumeSession(row, { ensureWorkspace, launch });
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
