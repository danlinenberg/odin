import { ODIN_AUTO_RENAME_SESSIONS_DEFAULT } from "@odin/shared/constants";
import { Input } from "@odin/ui/input";
import { Label } from "@odin/ui/label";
import { Switch } from "@odin/ui/switch";
import { createFileRoute } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useLaunchLimits } from "renderer/stores/launch-limits";
import type { LaunchLimits } from "shared/machine-load";

export const Route = createFileRoute("/_authenticated/settings/board/")({
	component: BoardSettingsPage,
});

/**
 * The board's own settings — no item-visibility plumbing, because every
 * setting on this page is Odin's own and shows in every variant.
 */
function BoardSettingsPage() {
	const utils = electronTrpc.useUtils();
	const { data: autoRename, isLoading } =
		electronTrpc.settings.getOdinAutoRenameSessions.useQuery();
	const setAutoRename =
		electronTrpc.settings.setOdinAutoRenameSessions.useMutation({
			onMutate: async ({ enabled }) => {
				await utils.settings.getOdinAutoRenameSessions.cancel();
				const previous = utils.settings.getOdinAutoRenameSessions.getData();
				utils.settings.getOdinAutoRenameSessions.setData(undefined, enabled);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getOdinAutoRenameSessions.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => utils.settings.getOdinAutoRenameSessions.invalidate(),
		});

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Board</h2>
				<p className="text-sm text-muted-foreground mt-1">
					How the board names, shows and starts your sessions
				</p>
			</div>

			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<div className="space-y-0.5">
						<Label
							htmlFor="auto-rename-sessions"
							className="text-sm font-medium"
						>
							Rename sessions automatically
						</Label>
						<p className="text-xs text-muted-foreground">
							Name each card after what its session turned out to be about,
							instead of the first line you typed. Renamed once, from the brief
							already written for the card; a name you set yourself is left
							alone.
						</p>
					</div>
					<Switch
						id="auto-rename-sessions"
						checked={autoRename ?? ODIN_AUTO_RENAME_SESSIONS_DEFAULT}
						onCheckedChange={(enabled) => setAutoRename.mutate({ enabled })}
						disabled={isLoading || setAutoRename.isPending}
					/>
				</div>

				<LaunchLimitRow
					id="launch-limit-host"
					field="hostCpuPercent"
					label="Hold new sessions when this Mac is"
					description="How busy this Mac's CPU is — Odin's sessions, builds, Docker, anything. At or above it, a new session waits in Idle → Queued and starts once the Mac calms down. Lower it if the Mac feels slow before sessions start queueing."
					min={1}
					max={100}
					step={1}
					unit="%"
				/>
				<LaunchLimitRow
					id="launch-limit-memory"
					field="minFreeMemoryGb"
					label="Hold new sessions when free memory is under"
					description="Memory this Mac could still hand out, cache included. Below it, a new session waits — an out-of-memory Mac swaps and crawls even while the CPU looks idle."
					min={0}
					max={64}
					step={0.5}
					unit="GB"
				/>
			</div>
		</div>
	);
}

/**
 * One launch-gate limit. Takes effect on the next queue tick (5s) and the
 * next launch; no restart.
 */
function LaunchLimitRow({
	id,
	field,
	label,
	description,
	min,
	max,
	step,
	unit,
}: {
	id: string;
	field: keyof LaunchLimits;
	label: string;
	description: string;
	min: number;
	max: number;
	step: number;
	unit: string;
}) {
	const value = useLaunchLimits((s) => s[field]);
	const setLimits = useLaunchLimits((s) => s.setLimits);
	return (
		<div className="flex items-center justify-between gap-6">
			<div className="space-y-0.5">
				<Label htmlFor={id} className="text-sm font-medium">
					{label}
				</Label>
				<p className="text-xs text-muted-foreground">{description}</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<Input
					id={id}
					type="number"
					min={min}
					max={max}
					step={step}
					defaultValue={value}
					className="w-20 tabular-nums"
					onChange={(event) => {
						const next = event.target.valueAsNumber;
						// ponytail: an empty or out-of-range box keeps the last good
						// value rather than arguing — the field is the only place to fix it.
						if (Number.isFinite(next) && next >= min && next <= max) {
							setLimits({ [field]: next });
						}
					}}
				/>
				<span className="text-sm text-muted-foreground">{unit}</span>
			</div>
		</div>
	);
}
