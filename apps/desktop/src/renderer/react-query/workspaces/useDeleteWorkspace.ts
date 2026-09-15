import {
	disposeHostSessionsForWorkspace,
	toastDisposeFailures,
} from "renderer/lib/dispose-host-sessions";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { removeWorkspaceFromGroups } from "./utils/workspace-removal";

type DeleteContext = {
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

export function useDeleteWorkspace(
	options?: Parameters<typeof electronTrpc.workspaces.delete.useMutation>[0],
) {
	const utils = electronTrpc.useUtils();

	return electronTrpc.workspaces.delete.useMutation({
		...options,
		onMutate: async ({ id }) => {
			await Promise.all([
				utils.workspaces.getAll.cancel(),
				utils.workspaces.getAllGrouped.cancel(),
			]);

			const previousGrouped = utils.workspaces.getAllGrouped.getData();
			const previousAll = utils.workspaces.getAll.getData();

			if (previousGrouped) {
				utils.workspaces.getAllGrouped.setData(
					undefined,
					removeWorkspaceFromGroups(previousGrouped, id),
				);
			}

			if (previousAll) {
				utils.workspaces.getAll.setData(
					undefined,
					previousAll.filter((w) => w.id !== id),
				);
			}

			return { previousGrouped, previousAll } as DeleteContext;
		},
		onSettled: async (...args) => {
			await utils.workspaces.invalidate();
			await options?.onSettled?.(...args);
		},
		onSuccess: async (data, variables, context, ...rest) => {
			// Delete succeeded on the electron path — dispose the workspace's
			// host-service terminals so backgrounded sessions don't leak.
			if (data.success) {
				const retryDispose = () =>
					disposeHostSessionsForWorkspace(utils, variables.id);
				toastDisposeFailures(await retryDispose(), retryDispose);
			}
			// tRPC treats { success: false } as a successful response, so roll back optimistic updates
			if (!data.success) {
				if (context?.previousGrouped !== undefined) {
					utils.workspaces.getAllGrouped.setData(
						undefined,
						context.previousGrouped,
					);
				}
				if (context?.previousAll !== undefined) {
					utils.workspaces.getAll.setData(undefined, context.previousAll);
				}
			}

			await options?.onSuccess?.(data, variables, context, ...rest);
		},
		onError: async (_err, variables, context, ...rest) => {
			if (context?.previousGrouped !== undefined) {
				utils.workspaces.getAllGrouped.setData(
					undefined,
					context.previousGrouped,
				);
			}
			if (context?.previousAll !== undefined) {
				utils.workspaces.getAll.setData(undefined, context.previousAll);
			}

			await options?.onError?.(_err, variables, context, ...rest);
		},
	});
}
