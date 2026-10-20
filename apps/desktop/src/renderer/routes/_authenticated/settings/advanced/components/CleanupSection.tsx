import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SettingRow, SettingsSection } from "../../components/SettingsPage";

/** What Odin deletes on its own. */
export function CleanupSection() {
	return (
		<SettingsSection title="Cleanup">
			<PruneMergedRow />
		</SettingsSection>
	);
}

/** Remove a session's worktree once its PR merges - main's pruner reads it. */
function PruneMergedRow() {
	const utils = electronTrpc.useUtils();
	const { data: enabled, isLoading } =
		electronTrpc.repos.getPruneMerged.useQuery();
	const setEnabled = electronTrpc.repos.setPruneMerged.useMutation({
		onSuccess: () => void utils.repos.getPruneMerged.invalidate(),
		onError: (error) => toast.error(error.message),
	});
	return (
		<SettingRow
			label="Delete worktrees when their PR merges"
			htmlFor="prune-merged-worktrees"
			description="Checked every 10 minutes in every repo with a .worktrees folder. A worktree with uncommitted files waits 7 days, then its files are saved to refs/pruned/<name> first. Off keeps every worktree."
		>
			<Switch
				id="prune-merged-worktrees"
				checked={enabled ?? true}
				onCheckedChange={(on) => setEnabled.mutate({ enabled: on })}
				disabled={isLoading || setEnabled.isPending}
			/>
		</SettingRow>
	);
}
