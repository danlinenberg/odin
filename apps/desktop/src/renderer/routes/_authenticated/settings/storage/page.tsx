import { Button } from "@odin/ui/button";
import { Checkbox } from "@odin/ui/checkbox";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { LuCloudUpload } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	SettingRow,
	SettingsPage,
	SettingsSection,
	StatusDot,
} from "../components/SettingsPage";

export const Route = createFileRoute("/_authenticated/settings/storage/")({
	component: StorageSettingsPage,
});

const gb = (bytes: number) =>
	bytes < 1024 ** 3
		? `${Math.round(bytes / 1024 ** 2)} MB`
		: `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function ago(ms: number | null): string {
	if (ms === null) return "-";
	const days = (Date.now() - ms) / 86_400_000;
	if (days < 1 / 24) return "just now";
	if (days < 1) return `${Math.round(days * 24)}h ago`;
	return `${Math.round(days)}d ago`;
}

/**
 * Settings > Storage: what Odin keeps on this Mac's disk and in iCloud. Every
 * session worktree, with what the 10-minute pruner would do to it (the ones
 * it would remove start ticked; any other can be ticked too, after a warning:
 * its branch stays and its uncommitted files are saved), the pruner's switch,
 * and the daily iCloud Drive copy of Odin's own data.
 */
function StorageSettingsPage() {
	const utils = electronTrpc.useUtils();
	const {
		data: listed,
		isLoading,
		error,
	} = electronTrpc.repos.worktrees.useQuery();
	const keyOf = (wt: { repo: string; name: string }) =>
		`${wt.repo}\0${wt.name}`;
	// Deleted rows leave the list one by one, before the re-list comes back.
	const [gone, setGone] = useState<Set<string>>(new Set());
	const worktrees = listed?.filter((wt) => !gone.has(keyOf(wt)));
	// Your ticks; an untouched row is ticked when the pruner would remove it.
	const [picks, setPicks] = useState<Map<string, boolean>>(new Map());
	const isPicked = (wt: { repo: string; name: string; safe: boolean }) =>
		picks.get(keyOf(wt)) ?? wt.safe;
	const selected = (worktrees ?? []).filter(isPicked);
	const allPicked = !!worktrees?.length && selected.length === worktrees.length;
	const selectedBytes = selected.reduce(
		(sum, wt) => sum + (wt.sizeBytes ?? 0),
		0,
	);
	const total = (worktrees ?? []).reduce(
		(sum, wt) => sum + (wt.sizeBytes ?? 0),
		0,
	);

	const remove = electronTrpc.repos.removeWorktrees.useMutation();
	const [progress, setProgress] = useState<{ done: number; total: number }>();

	const toggle = (wt: { repo: string; name: string; safe: boolean }) =>
		setPicks((prev) => new Map(prev).set(keyOf(wt), !isPicked(wt)));
	const pickAll = (on: boolean) =>
		setPicks(new Map((worktrees ?? []).map((wt) => [keyOf(wt), on])));
	const deleteSelected = async () => {
		const unlanded = selected.filter((wt) => !wt.safe).length;
		if (
			unlanded > 0 &&
			!window.confirm(
				`${unlanded} of these ${selected.length} have work main doesn't have. Deleting keeps each branch, and uncommitted files are saved to refs/pruned/<name>. Delete them?`,
			)
		)
			return;
		const batch = selected;
		setProgress({ done: 0, total: batch.length });
		let removed = 0;
		let freed = 0;
		const failures: string[] = [];
		// Repos side by side, one worktree at a time inside each: two git runs
		// in one repo would race for its worktree list.
		const byRepo = Map.groupBy(batch, (wt) => wt.repo);
		await Promise.all(
			[...byRepo.values()].map(async (wts) => {
				for (const wt of wts) {
					try {
						const done = await remove.mutateAsync([
							{ repo: wt.repo, name: wt.name, force: !wt.safe },
						]);
						if (done.length > 0) {
							removed++;
							freed += wt.sizeBytes ?? 0;
							setGone((prev) => new Set(prev).add(keyOf(wt)));
						}
					} catch (error) {
						failures.push(`${wt.name}: ${String(error)}`);
					}
					setProgress((p) => p && { ...p, done: p.done + 1 });
				}
			}),
		);
		const kept = batch.length - removed - failures.length;
		toast.success(
			`Deleted ${removed} worktree${removed === 1 ? "" : "s"}, freed ${gb(freed)}${kept ? ` - ${kept} kept, they changed since the list loaded` : ""}`,
		);
		if (failures.length > 0)
			toast.error(`Couldn't delete ${failures.length}: ${failures[0]}`);
		await utils.repos.worktrees.invalidate();
		setGone(new Set());
		setProgress(undefined);
	};

	return (
		<SettingsPage
			title="Storage"
			description="What Odin keeps on this Mac: a worktree per session, about 3 GB each, and a daily copy of its own data in iCloud Drive."
			action={
				<Button
					size="sm"
					disabled={selected.length === 0 || !!progress}
					onClick={() => void deleteSelected()}
				>
					{progress
						? `Deleting ${progress.done} of ${progress.total}…`
						: `Delete ${selected.length} (${gb(selectedBytes)})`}
				</Button>
			}
		>
			<SettingsSection
				title="Worktrees"
				description={
					<>
						Each agent session works in its own worktree. The ones whose work
						already landed on main are ticked. Deleting one with other work
						keeps its branch, and saves uncommitted files to refs/pruned/
						&lt;name&gt;.
						{worktrees &&
							` ${worktrees.length} ${worktrees.length === 1 ? "worktree" : "worktrees"}, ${gb(total)} in all.`}
					</>
				}
			>
				{isLoading ? (
					<p className="flex items-center gap-2 px-4 py-3.5 text-sm text-muted-foreground">
						<span className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary" />
						Checking every repo's worktrees - this fetches each repo, so it
						takes a moment…
					</p>
				) : error ? (
					// An older main process (a dev run started before this screen
					// existed) has no such query - say so, not "no worktrees".
					<p className="px-4 py-3.5 text-sm text-destructive">
						Couldn't list the worktrees: {error.message}. Restart Odin if it was
						running before an update.
					</p>
				) : !worktrees?.length ? (
					<p className="px-4 py-3.5 text-sm text-muted-foreground">
						No session worktrees on this Mac.
					</p>
				) : (
					<>
						<label
							htmlFor="storage-select-all"
							className="flex items-center gap-3 px-4 py-2.5 text-sm font-medium"
						>
							<Checkbox
								id="storage-select-all"
								checked={allPicked}
								onCheckedChange={() => pickAll(!allPicked)}
							/>
							Select all ({worktrees.length})
						</label>
						{worktrees.map((wt) => {
							const key = keyOf(wt);
							return (
								<label
									key={key}
									htmlFor={key}
									className="flex items-center gap-3 px-4 py-2.5 text-sm"
								>
									<Checkbox
										id={key}
										checked={isPicked(wt)}
										onCheckedChange={() => toggle(wt)}
									/>
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium" title={wt.path}>
											{wt.name.startsWith("/")
												? wt.name.split("/").slice(-2).join("/")
												: wt.name}
										</div>
										<div className="truncate text-xs text-muted-foreground">
											{wt.repo.split("/").pop()} ·{" "}
											{wt.reason.charAt(0).toUpperCase() + wt.reason.slice(1)}
										</div>
										{!wt.safe && isPicked(wt) && (
											<div className="truncate text-xs text-amber-500">
												Deleting keeps its branch; uncommitted files go to
												{wt.prunedRef}
											</div>
										)}
									</div>
									<span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
										{ago(wt.touchedAt)}
									</span>
									<span className="w-16 shrink-0 text-right font-mono text-xs">
										{wt.sizeBytes === null ? "-" : gb(wt.sizeBytes)}
									</span>
								</label>
							);
						})}
					</>
				)}
			</SettingsSection>

			<SettingsSection title="Cleanup">
				<PruneMergedRow />
			</SettingsSection>

			<SettingsSection title="Backup">
				<BackupRow />
			</SettingsSection>
		</SettingsPage>
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

/**
 * A place Odin's data goes, in the shape of an account row. The daily copy
 * itself runs in main (main/lib/backup-data.ts); this row only shows where it
 * landed and lets you force one.
 */
function BackupRow() {
	const status = electronTrpc.backup.status.useQuery();
	const run = electronTrpc.backup.run.useMutation({
		onSuccess: () => {
			void status.refetch();
			toast.success("Backed up to iCloud Drive");
		},
		onError: (error) => toast.error(error.message),
	});
	const disconnect = electronTrpc.backup.disconnect.useMutation({
		onSuccess: () => void status.refetch(),
		onError: (error) => toast.error(error.message),
	});
	const reveal = electronTrpc.backup.reveal.useMutation();
	const data = status.data;
	const identity = !data?.lastBackupAt
		? "Off until you back up once"
		: `Last ${new Date(data.lastBackupAt).toLocaleString([], {
				dateStyle: "medium",
				timeStyle: "short",
			})} · ${data.days} ${data.days === 1 ? "day" : "days"} kept`;
	return (
		<div data-setting="iCloud Drive" className="px-4 py-3.5">
			<div className="flex items-start justify-between gap-6">
				<div className="flex items-start gap-3 min-w-0">
					<div className="flex size-8 shrink-0 items-center justify-center">
						<LuCloudUpload className="size-5" />
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
							<span className="text-sm font-medium">iCloud Drive</span>
							<StatusDot
								loading={status.isLoading}
								configured={data?.available ?? false}
								identity={identity}
								error={null}
							/>
						</div>
						<div className="text-xs text-muted-foreground mt-0.5">
							Your board, briefs and scrollback, copied daily.
						</div>
						<div className="text-xs text-muted-foreground mt-1 max-w-[70ch]">
							{data?.available === false
								? "iCloud Drive is off, so nothing is copied. Turn it on in System Settings → Apple Account → iCloud."
								: !data?.lastBackupAt
									? "Back up now to turn on the daily copy. macOS asks once for access to iCloud Drive."
									: "Keeps 14 days in iCloud Drive → Odin Backups. To restore, quit Odin and copy a day's files back into ~/.odin."}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<Button
						variant="outline"
						size="sm"
						disabled={!data?.available || run.isPending}
						onClick={() => run.mutate()}
					>
						{run.isPending ? "Backing up…" : "Back up now"}
					</Button>
					{data?.lastBackupAt && (
						<Button variant="ghost" size="sm" onClick={() => reveal.mutate()}>
							Show
						</Button>
					)}
					{data?.lastBackupAt && (
						<Button
							variant="ghost"
							size="sm"
							disabled={disconnect.isPending}
							onClick={() => disconnect.mutate()}
						>
							Disconnect
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
