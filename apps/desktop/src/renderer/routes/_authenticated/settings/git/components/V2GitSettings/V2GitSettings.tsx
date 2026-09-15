import {
	type BranchPrefixMode,
	resolveBranchPrefix,
} from "@odin/shared/workspace-launch";
import { toast } from "@odin/ui/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { getHostServiceUnavailableMessage } from "renderer/lib/host-service-unavailable";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { BranchPrefixControl } from "../../../components/BranchPrefixControl";
import { SettingsRow } from "../../../components/SettingsRow";
import {
	useSetV2WorktreeBaseDir,
	useV2WorktreeLocationSettings,
	V2WorktreeLocationPicker,
} from "../../../components/V2WorktreeLocationPicker";
import { useDefaultWorktreePath } from "../../../components/WorktreeLocationPicker";

/**
 * v2 Git settings — the host-wide branch-prefix default for this machine.
 */
export function V2GitSettings() {
	const hostService = useLocalHostService();
	const { activeHostUrl } = hostService;
	const queryClient = useQueryClient();

	const worktreeQuery = useV2WorktreeLocationSettings(activeHostUrl);
	const setWorktreeBaseDir = useSetV2WorktreeBaseDir(activeHostUrl);
	const defaultWorktreePath = useDefaultWorktreePath();

	const branchPrefixQuery = useQuery({
		queryKey: ["host-branch-prefix", activeHostUrl] as const,
		enabled: !!activeHostUrl,
		queryFn: () => {
			if (!activeHostUrl) throw new Error("Host service unavailable");
			return getHostServiceClientByUrl(
				activeHostUrl,
			).settings.branchPrefix.get.query();
		},
	});

	const gitInfoQuery = useQuery({
		queryKey: ["host-git-info", activeHostUrl] as const,
		enabled: !!activeHostUrl,
		staleTime: 5 * 60 * 1000,
		queryFn: () => {
			if (!activeHostUrl) throw new Error("Host service unavailable");
			return getHostServiceClientByUrl(
				activeHostUrl,
			).settings.branchPrefix.gitInfo.query();
		},
	});

	const mode: BranchPrefixMode = branchPrefixQuery.data?.mode ?? "none";
	const customPrefix = branchPrefixQuery.data?.customPrefix ?? null;

	const setMutation = useMutation({
		mutationFn: (vars: {
			mode: BranchPrefixMode;
			customPrefix: string | null;
		}) => {
			if (!activeHostUrl) {
				throw new Error(
					getHostServiceUnavailableMessage(hostService, {
						action: "update the branch prefix",
					}),
				);
			}
			return getHostServiceClientByUrl(
				activeHostUrl,
			).settings.branchPrefix.set.mutate(vars);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["host-branch-prefix", activeHostUrl],
			});
		},
		onError: (err) =>
			toast.error(
				err instanceof Error ? err.message : "Failed to update branch prefix",
			),
	});

	const previewPrefix =
		resolveBranchPrefix({
			mode,
			customPrefix,
			authorPrefix: gitInfoQuery.data?.authorName,
			githubUsername: gitInfoQuery.data?.githubUsername,
		}) ||
		(mode === "author" ? "author-name" : mode === "github" ? "username" : null);

	const controlsDisabled =
		!activeHostUrl || branchPrefixQuery.isLoading || setMutation.isPending;

	return (
		<div className="p-6 max-w-4xl w-full mx-auto select-text">
			<header className="mb-8">
				<h2 className="text-xl font-semibold">Git &amp; worktrees</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Branch behavior for new workspaces on this device. Projects can
					override the prefix individually.
				</p>
			</header>

			<section>
				<SettingsRow
					label="Branch prefix"
					hint={
						<>
							Group new branches under a folder.{" "}
							<code className="rounded bg-muted px-1.5 py-0.5 text-foreground">
								{previewPrefix ? `${previewPrefix}/branch-name` : "branch-name"}
							</code>
						</>
					}
				>
					<BranchPrefixControl
						mode={mode}
						customPrefix={customPrefix}
						disabled={controlsDisabled}
						onChange={(next) =>
							setMutation.mutate({
								mode: next.mode ?? "none",
								customPrefix: next.customPrefix,
							})
						}
					/>
				</SettingsRow>
				<SettingsRow
					label="Worktree location"
					hint="Base directory for new worktrees on this device."
				>
					<V2WorktreeLocationPicker
						currentPath={worktreeQuery.data?.worktreeBaseDir ?? null}
						fallbackPath={
							worktreeQuery.data?.defaultWorktreeBaseDir ?? defaultWorktreePath
						}
						hostUrl={activeHostUrl}
						disabled={
							!activeHostUrl ||
							worktreeQuery.isLoading ||
							setWorktreeBaseDir.isPending
						}
						browseTitle="Select default worktree location"
						onSelect={(path) => setWorktreeBaseDir.mutate(path)}
						onReset={() => setWorktreeBaseDir.mutate(null)}
					/>
				</SettingsRow>
			</section>
		</div>
	);
}
