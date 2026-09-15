import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceInitStore } from "renderer/stores/workspace-init";
import type { WorkspaceInitProgress } from "shared/types/workspace-init";

export function useOpenMainRepoWorkspace(
	options?: Parameters<
		typeof electronTrpc.workspaces.openMainRepoWorkspace.useMutation
	>[0],
) {
	const utils = electronTrpc.useUtils();
	const addPendingTerminalSetup = useWorkspaceInitStore(
		(s) => s.addPendingTerminalSetup,
	);
	const updateProgress = useWorkspaceInitStore((s) => s.updateProgress);

	return electronTrpc.workspaces.openMainRepoWorkspace.useMutation({
		...options,
		onSuccess: async (data, ...rest) => {
			await utils.workspaces.invalidate();

			if (!data.wasExisting) {
				let setupData = null;
				try {
					setupData = await utils.workspaces.getSetupCommands.fetch({
						workspaceId: data.workspace.id,
					});
				} catch (error) {
					console.error(
						"[useOpenMainRepoWorkspace] Failed to fetch setup commands:",
						error,
					);
				}

				addPendingTerminalSetup({
					workspaceId: data.workspace.id,
					projectId: data.projectId,
					initialCommands: setupData?.initialCommands ?? null,
					defaultPresets: setupData?.defaultPresets ?? [],
				});

				// Branch workspaces skip git init, so mark ready immediately to trigger terminal setup
				const readyProgress: WorkspaceInitProgress = {
					workspaceId: data.workspace.id,
					projectId: data.projectId,
					step: "ready",
					message: "Ready",
				};
				updateProgress(readyProgress);
			}

			await options?.onSuccess?.(data, ...rest);
		},
	});
}
