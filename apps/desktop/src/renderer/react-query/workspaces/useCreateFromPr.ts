import type { AgentLaunchRequest } from "@odin/shared/agent-launch";
import { useCallback, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceInitStore } from "renderer/stores/workspace-init";
import type { WorkspaceInitProgress } from "shared/types/workspace-init";

type MutationOptions = Parameters<
	typeof electronTrpc.workspaces.createFromPr.useMutation
>[0];

export function useCreateFromPr(options?: MutationOptions) {
	const utils = electronTrpc.useUtils();
	const addPendingTerminalSetup = useWorkspaceInitStore(
		(s) => s.addPendingTerminalSetup,
	);
	const updateProgress = useWorkspaceInitStore((s) => s.updateProgress);
	const pendingLaunchRequestRef = useRef<AgentLaunchRequest | null>(null);

	const mutation = electronTrpc.workspaces.createFromPr.useMutation({
		...options,
		onSuccess: async (data, ...rest) => {
			const agentLaunchRequest = pendingLaunchRequestRef.current;
			pendingLaunchRequestRef.current = null;

			if (!data.wasExisting && (data.initialCommands || agentLaunchRequest)) {
				const optimisticProgress: WorkspaceInitProgress = {
					workspaceId: data.workspace.id,
					projectId: data.projectId,
					step: "pending",
					message: "Preparing...",
				};
				updateProgress(optimisticProgress);
			}

			const normalizedLaunchRequest = agentLaunchRequest
				? { ...agentLaunchRequest, workspaceId: data.workspace.id }
				: undefined;

			if (data.initialCommands || normalizedLaunchRequest) {
				addPendingTerminalSetup({
					workspaceId: data.workspace.id,
					projectId: data.projectId,
					initialCommands: data.initialCommands,
					agentLaunchRequest: normalizedLaunchRequest,
				});
			}

			await utils.workspaces.invalidate();

			await options?.onSuccess?.(data, ...rest);
		},
	});

	const mutateAsyncWithSetup = useCallback(
		async (
			input: Parameters<typeof mutation.mutateAsync>[0],
			agentLaunchRequest?: AgentLaunchRequest,
		) => {
			pendingLaunchRequestRef.current = agentLaunchRequest ?? null;
			try {
				return await mutation.mutateAsync(input);
			} finally {
				pendingLaunchRequestRef.current = null;
			}
		},
		[mutation],
	);

	return {
		...mutation,
		mutateAsyncWithSetup,
	};
}
