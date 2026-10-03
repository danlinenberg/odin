import { ODIN_AUTO_RENAME_SESSIONS_DEFAULT } from "@odin/shared/constants";
import { Button } from "@odin/ui/button";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { createFileRoute } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useIdleClose } from "renderer/stores/idle-close";
import { useLaunchLimits } from "renderer/stores/launch-limits";
import type { LaunchLimits } from "shared/machine-load";
import {
	NumberSetting,
	SettingRow,
	SettingsPage,
	SettingsSection,
} from "../components/SettingsPage";

export const Route = createFileRoute("/_authenticated/settings/sessions/")({
	component: SessionsSettingsPage,
});

function SessionsSettingsPage() {
	return (
		<SettingsPage
			title="Sessions"
			description="Where a new agent session starts, when it has to wait its turn, and what the board does with it afterwards."
		>
			<SettingsSection title="Where they start">
				<DefaultRepoRow />
			</SettingsSection>

			<SettingsSection
				title="When they start"
				description="A new session waits in Idle → Queued until all of these allow it. Changes apply within 5 seconds."
			>
				<LaunchLimitRow
					id="launch-limit-host"
					field="hostCpuPercent"
					label="Hold new sessions when this Mac is"
					description="Total CPU load — Odin's sessions, builds, Docker, anything. Lower it if the Mac feels slow before sessions start queueing."
					min={1}
					max={100}
					step={1}
					unit="% busy"
				/>
				<LaunchLimitRow
					id="launch-limit-memory"
					field="minFreeMemoryGb"
					label="Hold new sessions when free memory is under"
					description="Memory still available, cache included. A Mac out of memory swaps and crawls even when the CPU looks idle."
					min={0}
					max={64}
					step={0.5}
					unit="GB"
				/>
				<LaunchLimitRow
					id="launch-limit-agents"
					field="maxWorkingAgents"
					label="Hold new sessions when this many are working"
					description="Sessions waiting on you don't count. 0 means no limit."
					min={0}
					max={50}
					step={1}
					unit="sessions"
				/>
				<OneSessionPerCheckoutRow />
			</SettingsSection>

			<SettingsSection title="On the board">
				<AutoRenameRow />
				<IdleCloseRow />
			</SettingsSection>
		</SettingsPage>
	);
}

/**
 * The checkout a session starts in when nothing else names one — the board's
 * new-task input, "Start session", anything without a repo picked. Machine-wide,
 * not per-profile.
 */
function DefaultRepoRow() {
	const utils = electronTrpc.useUtils();
	const { data: path, isLoading } = electronTrpc.repos.getDefault.useQuery();
	const selectDirectory = electronTrpc.window.selectDirectory.useMutation();
	const setDefault = electronTrpc.repos.setDefault.useMutation({
		onSuccess: () => void utils.repos.getDefault.invalidate(),
		onError: (error) => toast.error(error.message),
	});
	const busy = isLoading || selectDirectory.isPending || setDefault.isPending;

	const browse = async () => {
		const result = await selectDirectory.mutateAsync({
			title: "Select default repo",
			defaultPath: path ?? undefined,
		});
		if (!result.canceled && result.path) {
			setDefault.mutate({ path: result.path });
		}
	};

	return (
		<SettingRow
			label="Default repo"
			description="Where a session starts when no repo is picked. Unset falls back to the workspace you opened last."
			stacked
		>
			<div className="flex items-center gap-2">
				<code className="min-w-0 flex-1 select-text truncate rounded-md bg-muted px-2.5 py-1.5 text-xs">
					{path ?? "Not set"}
				</code>
				<Button
					variant="outline"
					size="sm"
					className="h-8"
					disabled={busy}
					onClick={browse}
				>
					Browse…
				</Button>
				{path && (
					<Button
						variant="ghost"
						size="sm"
						className="h-8"
						disabled={busy}
						onClick={() => setDefault.mutate({ path: null })}
					>
						Clear
					</Button>
				)}
			</div>
		</SettingRow>
	);
}

/** One launch-gate limit. Takes effect on the next queue tick (5s). */
function LaunchLimitRow({
	id,
	field,
	label,
	description,
	...range
}: {
	id: string;
	field: Exclude<keyof LaunchLimits, "oneSessionPerCheckout">;
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
		<SettingRow label={label} htmlFor={id} description={description}>
			<NumberSetting
				id={id}
				value={value}
				{...range}
				onChange={(next) => setLimits({ [field]: next })}
			/>
		</SettingRow>
	);
}

/** Hold a second session out of a checkout one is already working in. */
function OneSessionPerCheckoutRow() {
	const enabled = useLaunchLimits((s) => s.oneSessionPerCheckout !== false);
	const setLimits = useLaunchLimits((s) => s.setLimits);
	return (
		<SettingRow
			label="One session per repo at a time"
			htmlFor="one-session-per-checkout"
			description="A session started in a repo another one is working in waits in Queued until that one stops. Off lets them run side by side — they share one working tree, so each sees the other's edits."
		>
			<Switch
				id="one-session-per-checkout"
				checked={enabled}
				onCheckedChange={(on) => setLimits({ oneSessionPerCheckout: on })}
			/>
		</SettingRow>
	);
}

/** Name each card after what its session turned out to be about. */
function AutoRenameRow() {
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
		<SettingRow
			label="Rename sessions automatically"
			htmlFor="auto-rename-sessions"
			description="Name each card after what its session turned out to be about, not the first line you typed. Happens once; names you set yourself are kept."
		>
			<Switch
				id="auto-rename-sessions"
				checked={autoRename ?? ODIN_AUTO_RENAME_SESSIONS_DEFAULT}
				onCheckedChange={(enabled) => setAutoRename.mutate({ enabled })}
				disabled={isLoading || setAutoRename.isPending}
			/>
		</SettingRow>
	);
}

/** When the board closes a session that's sat idle. Next minute's sweep. */
function IdleCloseRow() {
	const hours = useIdleClose((s) => s.hours);
	const setHours = useIdleClose((s) => s.setHours);
	return (
		<SettingRow
			label="Close idle sessions after"
			htmlFor="idle-close-hours"
			description="A session out of Working this long, with nothing running in its shell, is closed. Its card stays in its column; Resume reopens it. 0 never closes."
		>
			<NumberSetting
				id="idle-close-hours"
				value={hours}
				min={0}
				max={168}
				step={0.5}
				unit="hours"
				onChange={setHours}
			/>
		</SettingRow>
	);
}
