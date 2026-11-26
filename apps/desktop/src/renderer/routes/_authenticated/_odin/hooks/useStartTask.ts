import { toast } from "@odin/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import type { SessionContext } from "../components/SessionContextDialog";
import { type OdinTask, taskPrompt, useMyTasks } from "./useOdinTasks";
import { useOdinWorkspace } from "./useOdinWorkspace";
import { usePendingFocus } from "./usePendingFocus";

/**
 * Start a My Tasks row as a session and jump to it on the board. Shared by the
 * row's Start button and the New task box's "Start now".
 */
/**
 * What a launch that threw tells the user. Most often it's a machine without
 * Git: a fresh Windows, or a Mac without the Command Line Tools, where
 * /usr/bin/git is a stub that opens Apple's installer and fails with
 * xcode-select's note.
 */
export function launchErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return /spawn git ENOENT/.test(message)
		? "Odin needs Git to start a session. Install it from git-scm.com, then restart Odin."
		: /xcode-select|No developer tools were found/.test(message)
			? "Odin needs Git to start a session. macOS just opened an installer for it - click Install, wait for it to finish, then try again."
			: `Couldn't start the session: ${message}`;
}

export function useStartTask() {
	const { setPane } = useMyTasks();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const navigate = useNavigate();

	const startTask = async (task: OdinTask, context?: SessionContext) => {
		try {
			await start(task, context);
		} catch (error) {
			toast.error(launchErrorMessage(error));
		}
	};

	const start = async (task: OdinTask, context?: SessionContext) => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const result = await launch({
			...context,
			key: task.id,
			workspaceId: ensured.workspace.id,
			title: task.title,
			description: task.notes || null,
			brief: taskPrompt(task),
			skill: task.skill,
			repoPath: task.repo,
		});
		if (!result.ok) return toast.error(result.error);
		// The task keeps its row and gains a way into the session - starting one
		// isn't finishing it, so it's still yours to ✕ when it's actually done.
		setPane(task.id, result.paneId);
		usePendingFocus.getState().focus(result.paneId);
		navigate({ to: "/board" });
	};

	return { startTask, isLaunching, launchingKey };
}
