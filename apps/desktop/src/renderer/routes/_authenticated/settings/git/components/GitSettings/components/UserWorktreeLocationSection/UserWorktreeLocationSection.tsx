import { Label } from "@odin/ui/label";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import {
	useSetV2WorktreeBaseDir,
	useV2WorktreeLocationSettings,
	V2WorktreeLocationPicker,
} from "renderer/routes/_authenticated/settings/components/V2WorktreeLocationPicker";
import {
	useDefaultWorktreePath,
	WorktreeLocationPicker,
} from "renderer/routes/_authenticated/settings/components/WorktreeLocationPicker";

export function UserWorktreeLocationSection() {
	const isV2CloudEnabled = useIsV2CloudEnabled();
	return isV2CloudEnabled ? <V2Body /> : <V1Body />;
}

function V1Body() {
	const utils = electronTrpc.useUtils();
	const defaultWorktreePath = useDefaultWorktreePath();

	const { data: worktreeBaseDir, isLoading } =
		electronTrpc.settings.getWorktreeBaseDir.useQuery();
	const setWorktreeBaseDir =
		electronTrpc.settings.setWorktreeBaseDir.useMutation({
			onMutate: async ({ path }) => {
				await utils.settings.getWorktreeBaseDir.cancel();
				const previous = utils.settings.getWorktreeBaseDir.getData();
				utils.settings.getWorktreeBaseDir.setData(undefined, path);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getWorktreeBaseDir.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => {
				utils.settings.getWorktreeBaseDir.invalidate();
			},
		});

	return (
		<div className="space-y-0.5">
			<Label className="text-sm font-medium">Worktree location</Label>
			<p className="text-xs text-muted-foreground">
				Base directory for new worktrees
			</p>
			<WorktreeLocationPicker
				currentPath={worktreeBaseDir}
				defaultPathLabel={`Default (${defaultWorktreePath})`}
				defaultBrowsePath={worktreeBaseDir}
				disabled={isLoading || setWorktreeBaseDir.isPending}
				onSelect={(path) => setWorktreeBaseDir.mutate({ path })}
				onReset={() => setWorktreeBaseDir.mutate({ path: null })}
			/>
		</div>
	);
}

function V2Body() {
	const { activeHostUrl } = useLocalHostService();
	const defaultWorktreePath = useDefaultWorktreePath();

	const settingsQuery = useV2WorktreeLocationSettings(activeHostUrl);
	const setLocation = useSetV2WorktreeBaseDir(activeHostUrl);

	const disabled =
		!activeHostUrl || settingsQuery.isLoading || setLocation.isPending;

	return (
		<div className="space-y-2">
			<div className="space-y-0.5">
				<Label className="text-sm font-medium">Worktree location</Label>
				<p className="text-xs text-muted-foreground">
					Base directory for new worktrees
				</p>
			</div>
			<V2WorktreeLocationPicker
				currentPath={settingsQuery.data?.worktreeBaseDir ?? null}
				fallbackPath={
					settingsQuery.data?.defaultWorktreeBaseDir ?? defaultWorktreePath
				}
				hostUrl={activeHostUrl}
				disabled={disabled}
				browseTitle="Select default worktree location"
				onSelect={(path) => setLocation.mutate(path)}
				onReset={() => setLocation.mutate(null)}
			/>
		</div>
	);
}
