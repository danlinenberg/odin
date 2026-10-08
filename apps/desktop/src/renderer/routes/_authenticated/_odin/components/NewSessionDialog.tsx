import { toast } from "@odin/ui/sonner";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import {
	OdinPromptDialog,
	type PromptImage,
	sessionTitle,
} from "./OdinPromptDialog";

/**
 * "+ New Session": describe a task, pick the repo, and an agent session starts
 * on it. The Dev Board and Home both open this one.
 */
export function NewSessionDialog({
	onClose,
	onLaunched,
}: {
	onClose: () => void;
	onLaunched?: (paneId: string) => void;
}) {
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch } = useLaunchTaskSession();
	const { data: projects = [] } = electronTrpc.projects.getRecents.useQuery();

	const handleNewSession = async (
		rawPrompt: string,
		images: PromptImage[],
		repoPath: string,
	) => {
		const prompt = rawPrompt.trim();
		if (!prompt && images.length === 0) return;
		const ensured = await ensureWorkspace();
		if (!ensured.ok) {
			toast.error(ensured.error);
			return;
		}
		// First line names the session; the full prompt (multi-line) rides in the
		// task file as the description.
		const title = sessionTitle(prompt, "New session");
		const result = await launch({
			workspaceId: ensured.workspace.id,
			title,
			description: prompt && prompt !== title ? prompt : null,
			images,
			repoPath,
		});
		onClose();
		if (result.ok) {
			usePaneMeta.getState().setBrief(result.paneId, prompt || title);
			usePaneMeta.getState().setTitle(result.paneId, title);
			usePaneMeta.getState().setSessionId(result.paneId, result.sessionId);
			const mainRepoPath = projects.find(
				(project) => project.id === ensured.workspace.projectId,
			)?.mainRepoPath;
			toast.success(
				`Session started in ${(repoPath || mainRepoPath || "").split("/").pop() || "your repo"}`,
			);
			onLaunched?.(result.paneId);
		} else {
			toast.error(result.error);
		}
	};

	return (
		<OdinPromptDialog
			heading="New Session"
			placeholder="What should the agent do? (it picks the repo)"
			repoPicker
			onCancel={onClose}
			onSubmit={handleNewSession}
		/>
	);
}
