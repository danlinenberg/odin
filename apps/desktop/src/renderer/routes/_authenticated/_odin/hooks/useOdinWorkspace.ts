import type { SelectWorkspace } from "@odin/local-db";
import { useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Workspace selection for the Odin views, with zero-friction provisioning:
 * when no workspace exists, `ensureWorkspace` creates a project + main
 * workspace from the default repo (no dialogs), so "Start session" and the
 * board's new-task input always have a target.
 */
export function useOdinWorkspace() {
	const utils = electronTrpc.useUtils();
	const { data: defaultRepo } = electronTrpc.repos.getDefault.useQuery();
	const { data: workspaces = [] } = electronTrpc.workspaces.getAll.useQuery();
	const openFromPath = electronTrpc.projects.openFromPath.useMutation();
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
		null,
	);

	const defaultWorkspace = useMemo(
		() =>
			[...workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ??
			null,
		[workspaces],
	);
	const launchWorkspace: SelectWorkspace | null =
		workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
		defaultWorkspace;

	/**
	 * Returns a workspace to launch into, provisioning one if needed.
	 *
	 * The configured default repo wins over the most recently opened workspace:
	 * sessions write their task/brief files into `<cwd>/.odin/`, so
	 * last-opened-wins quietly scattered them across whichever repo happened to
	 * be touched last. Last-opened is only a fallback now.
	 *
	 * `repoOverride` pins a specific checkout — "Work on Odin" passes Odin's own
	 * repo so the agent starts there rather than working out where it lives.
	 */
	const ensureWorkspace = async (
		repoOverride?: string | null,
	): Promise<
		{ ok: true; workspace: SelectWorkspace } | { ok: false; error: string }
	> => {
		const fallback = (error: string) =>
			launchWorkspace
				? ({ ok: true, workspace: launchWorkspace } as const)
				: ({ ok: false, error } as const);

		const repoPath = repoOverride ?? defaultRepo;
		if (!repoPath) {
			return fallback(
				"No workspace and no default repo — set one in Settings → Connections.",
			);
		}
		// ponytail: unconditional — openFromPath upserts the project and its main
		// workspace, so this resolves an already-open repo instead of duplicating it.
		const result = await openFromPath.mutateAsync({ path: repoPath });
		if ("error" in result && result.error) {
			return fallback(result.error);
		}
		if (!("project" in result) || !result.project) {
			return fallback(`Could not open repo at ${repoPath}`);
		}
		const all = await utils.workspaces.getAll.fetch();
		const workspace =
			all.find((item) => item.projectId === result.project?.id) ?? null;
		// Not awaited: the fetch above already refreshed the cache, and waiting
		// on a second round-trip only delays the session start.
		void utils.workspaces.getAll.invalidate();
		if (!workspace) {
			return fallback("Workspace was not created");
		}
		return { ok: true, workspace };
	};

	return {
		workspaces,
		launchWorkspace,
		setSelectedWorkspaceId,
		ensureWorkspace,
	};
}
