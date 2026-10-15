import { Button } from "@odin/ui/button";
import { Checkbox } from "@odin/ui/checkbox";
import { toast } from "@odin/ui/sonner";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SettingsPage, SettingsSection } from "../components/SettingsPage";

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
 * Every session worktree on the Mac, with what the 10-minute pruner would do
 * to it. The ones it would remove start ticked. Any other can be ticked too,
 * after a warning: its branch stays and its uncommitted files are saved.
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
			description="Each agent session works in its own worktree, a full install of about 3 GB. The ones whose work already landed on main are ticked. Deleting one with other work keeps its branch, and saves uncommitted files to refs/pruned/<name>."
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
					worktrees
						? `${worktrees.length} ${worktrees.length === 1 ? "worktree" : "worktrees"}, ${gb(total)} in all.`
						: undefined
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
		</SettingsPage>
	);
}
