import { toast } from "@odin/ui/sonner";
import { useCallback } from "react";
import { useCreateOrAttachWithTheme } from "renderer/hooks/useCreateOrAttachWithTheme";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { bootstrapOpenWorktree } from "./bootstrap-open-worktree";

interface OpenedWorktreeData {
	workspace: { id: string };
	initialCommands?: string[] | null;
}

export function useHandleOpenedWorktree() {
	const utils = electronTrpc.useUtils();
	const addTab = useTabsStore((state) => state.addTab);
	const setTabAutoTitle = useTabsStore((state) => state.setTabAutoTitle);
	const createOrAttach = useCreateOrAttachWithTheme();
	const writeToTerminal = electronTrpc.terminal.write.useMutation();

	return useCallback(
		async (data: OpenedWorktreeData) => {
			await utils.workspaces.invalidate();
			await utils.projects.getRecents.invalidate();

			const bootstrapError = await bootstrapOpenWorktree({
				data,
				addTab,
				setTabAutoTitle,
				createOrAttach: (input) => createOrAttach.mutateAsync(input),
				writeToTerminal: (input) => writeToTerminal.mutateAsync(input),
			});
			if (bootstrapError === "create_or_attach_failed") {
				toast.error("Workspace opened, but terminal failed to start.");
			}
			if (bootstrapError === "write_initial_commands_failed") {
				toast.error("Workspace opened, but setup command failed.");
			}
		},
		[
			addTab,
			createOrAttach,
			setTabAutoTitle,
			utils.projects.getRecents,
			utils.workspaces,
			writeToTerminal,
		],
	);
}
