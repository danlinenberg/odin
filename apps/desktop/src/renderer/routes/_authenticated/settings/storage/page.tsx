import { Button } from "@odin/ui/button";
import { Checkbox } from "@odin/ui/checkbox";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
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
 * to it. Only the ones it would remove can be ticked - they start ticked - so
 * nothing with work main doesn't have can go from here.
 */
function StorageSettingsPage() {
	const utils = electronTrpc.useUtils();
	const {
		data: worktrees,
		isLoading,
		error,
	} = electronTrpc.repos.worktrees.useQuery();
	const [unticked, setUnticked] = useState<Set<string>>(new Set());
	const keyOf = (wt: { repo: string; name: string }) =>
		`${wt.repo}\0${wt.name}`;
	const selected = (worktrees ?? []).filter(
		(wt) => wt.safe && !unticked.has(keyOf(wt)),
	);
	const selectedBytes = selected.reduce(
		(sum, wt) => sum + (wt.sizeBytes ?? 0),
		0,
	);
	const total = (worktrees ?? []).reduce(
		(sum, wt) => sum + (wt.sizeBytes ?? 0),
		0,
	);

	const remove = electronTrpc.repos.removeWorktrees.useMutation({
		onSuccess: (removed) => {
			const freed = selected
				.filter((wt) => removed.includes(keyOf(wt)))
				.reduce((sum, wt) => sum + (wt.sizeBytes ?? 0), 0);
			const skipped = selected.length - removed.length;
			toast.success(
				`Deleted ${removed.length} worktree${removed.length === 1 ? "" : "s"}, freed ${gb(freed)}${skipped ? ` - ${skipped} kept, they changed since the list loaded` : ""}`,
			);
			void utils.repos.worktrees.invalidate();
		},
		onError: (error) => toast.error(error.message),
	});

	const toggle = (key: string) =>
		setUnticked((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	return (
		<SettingsPage
			title="Storage"
			description="Each agent session works in its own worktree, a full install of about 3 GB. The ones whose work already landed on main are ticked. Work main doesn't have can't be deleted here."
			action={
				<Button
					size="sm"
					disabled={selected.length === 0 || remove.isPending}
					onClick={() =>
						remove.mutate(selected.map(({ repo, name }) => ({ repo, name })))
					}
				>
					{remove.isPending
						? "Deleting…"
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
					worktrees.map((wt) => {
						const key = keyOf(wt);
						return (
							<label
								key={key}
								htmlFor={key}
								className={cn(
									"flex items-center gap-3 px-4 py-2.5 text-sm",
									!wt.safe && "opacity-70",
								)}
							>
								<Checkbox
									id={key}
									checked={wt.safe && !unticked.has(key)}
									disabled={!wt.safe}
									onCheckedChange={() => toggle(key)}
								/>
								<div className="min-w-0 flex-1">
									<div className="truncate font-medium">{wt.name}</div>
									<div className="truncate text-xs text-muted-foreground">
										{wt.repo.split("/").pop()} ·{" "}
										{wt.reason.charAt(0).toUpperCase() + wt.reason.slice(1)}
									</div>
								</div>
								<span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
									{ago(wt.touchedAt)}
								</span>
								<span className="w-16 shrink-0 text-right font-mono text-xs">
									{wt.sizeBytes === null ? "-" : gb(wt.sizeBytes)}
								</span>
							</label>
						);
					})
				)}
			</SettingsSection>
		</SettingsPage>
	);
}
