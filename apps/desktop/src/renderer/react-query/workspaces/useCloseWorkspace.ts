import {
	disposeHostSessionsForWorkspace,
	toastDisposeFailures,
} from "renderer/lib/dispose-host-sessions";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { removeWorkspaceFromGroups } from "./utils/workspace-removal";

type CloseContext = {
	previousGrouped: ReturnType<
		typeof electronTrpc.useUtils
	>["workspaces"]["getAllGrouped"]["getData"] extends () => infer R
		? R
		: never;
	previousAll: ReturnType<
		typeof electronTrpc.useUtils
	>["workspaces"]["getAll"]["getData"] extends () => infer R
		? R
		: never;
};

/**
 * Mutation hook for closing a workspace without deleting the worktree
 * Uses optimistic updates to immediately remove workspace from UI,
 * then performs actual close in background.
 */
export function useCloseWorkspace(
	options?: Parameters<typeof electronTrpc.workspaces.close.useMutation>[0],
) {
	const utils = electronTrpc.useUtils();

	return electronTrpc.workspaces.close.useMutation({
		...options,
		onMutate: async ({ id }) => {
			// Cancel outgoing refetches to avoid overwriting optimistic update
			await Promise.all([
				utils.workspaces.getAll.cancel(),
				utils.workspaces.getAllGrouped.cancel(),
			]);

			// Snapshot previous values for rollback
			const previousGrouped = utils.workspaces.getAllGrouped.getData();
			const previousAll = utils.workspaces.getAll.getData();

			// Optimistically remove workspace from getAllGrouped cache
			if (previousGrouped) {
				utils.workspaces.getAllGrouped.setData(
					undefined,
					removeWorkspaceFromGroups(previousGrouped, id),
				);
			}

			// Optimistically remove workspace from getAll cache
			if (previousAll) {
				utils.workspaces.getAll.setData(
					undefined,
					previousAll.filter((w) => w.id !== id),
				);
			}

			// Return context for rollback
			return { previousGrouped, previousAll } as CloseContext;
		},
		onError: async (err, variables, context, ...rest) => {
			// Rollback to previous state on error
			if (context?.previousGrouped !== undefined) {
				utils.workspaces.getAllGrouped.setData(
					undefined,
					context.previousGrouped,
				);
			}
			if (context?.previousAll !== undefined) {
				utils.workspaces.getAll.setData(undefined, context.previousAll);
			}
			await options?.onError?.(err, variables, context, ...rest);
		},
		onSuccess: async (data, variables, ...rest) => {
			// Close keeps the worktree but tears down the workspace's runtime;
			// dispose its host-service terminals so backgrounded sessions don't leak.
			const retryDispose = () =>
				disposeHostSessionsForWorkspace(utils, variables.id);
			toastDisposeFailures(await retryDispose(), retryDispose);
			// Invalidate to ensure consistency with backend state
			await utils.workspaces.invalidate();
			// Invalidate project queries since close updates project metadata
			await utils.projects.getRecents.invalidate();

			// Call user's onSuccess if provided
			await options?.onSuccess?.(data, variables, ...rest);
		},
	});
}
