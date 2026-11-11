import { ODIN_AUTO_RENAME_SESSIONS_DEFAULT } from "@odin/shared/constants";
import { Button } from "@odin/ui/button";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { createFileRoute } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useIdleClose } from "renderer/stores/idle-close";
import { useIdleCompact } from "renderer/stores/idle-compact";
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

/**
 * Settings > Sessions: a session's life on this Mac, top to bottom - the
 * folder it starts in, what it runs, when it has to wait, and what the board
 * does with it afterwards. Running one elsewhere is Settings > Remote; how
 * its drafts sound is Settings > Personalization.
 */
function SessionsSettingsPage() {
	return (
		<SettingsPage
			title="Sessions"
			description="Where a new agent session starts, when it has to wait its turn, and what the board does with it afterwards."
		>
			<SettingsSection title="Where they start">
				<DefaultRepoRow />
				<FullDiskAccessRow />
			</SettingsSection>

			<SettingsSection
				title="When they start"
				description="A new session waits in Idle → Queued until all of these allow it. Changes apply within 5 seconds."
			>
				<LaunchLimitRow
					id="launch-limit-host"
					field="hostCpuPercent"
					label="Hold new sessions when this computer is"
					description="Total CPU load - Odin's sessions, builds, Docker, anything. Lower it if the Mac feels slow before sessions start queueing."
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
					id="launch-limit-disk"
					field="minFreeDiskGb"
					label="Hold new sessions when free disk is under"
					description="Free space on the home disk, shown in the top bar. Each session takes a ~3 GB worktree, and a full disk also starves memory. 0 means no limit."
					min={0}
					max={500}
					step={1}
					unit="GB free"
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

			<SettingsSection
				title="On the board"
				description="What the board does with a session once it is running."
			>
				<AutoRenameRow />
				<IdleCompactRow />
				<IdleCloseRow />
			</SettingsSection>

			<SettingsSection title="When they won't start">
				<RestartCompletelyRow />
			</SettingsSection>
		</SettingsPage>
	);
}

/**
 * The checkout a session starts in when nothing else names one - the board's
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
			title: "Select default folder",
			defaultPath: path ?? undefined,
		});
		if (!result.canceled && result.path) {
			setDefault.mutate({ path: result.path });
		}
	};

	return (
		<SettingRow
			label="Default folder"
			description="Where a session starts when no repo is picked. Any folder works, git or not. Unset: the folder your repos live in, detected."
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

/**
 * macOS charges everything a session runs to Odin, so one `find ~` in a
 * session pops "Odin wants your music / photo library". Full Disk Access
 * covers those folders up front. Odin can't grant itself it - this opens the
 * pane where you switch it on.
 */
function FullDiskAccessRow() {
	const { data: status } = electronTrpc.permissions.getStatus.useQuery(
		undefined,
		{ refetchInterval: 2000 },
	);
	const open = electronTrpc.permissions.requestFullDiskAccess.useMutation();
	const granted = status?.fullDiskAccess === true;
	return (
		<SettingRow
			label="Full Disk Access"
			description="Without it, macOS asks again each time a session reads a protected folder (Music, Photos, Desktop, Documents) and names Odin in the prompt. Turn Odin on in the list that opens."
		>
			{granted ? (
				<span className="text-xs text-muted-foreground">On</span>
			) : (
				<Button
					variant="outline"
					size="sm"
					className="h-8"
					onClick={() => open.mutate()}
				>
					Open System Settings
				</Button>
			)}
		</SettingRow>
	);
}

/**
 * Terminals run in a daemon that outlives Odin's restarts and updates. One
 * that broke stays broken until it is restarted. macOS also has this in the
 * Odin menu; Windows and Linux have no app menu, so this is their only way.
 */
function RestartCompletelyRow() {
	const restart = electronTrpc.settings.restartCompletely.useMutation({
		onError: (error) => toast.error(error.message),
	});
	return (
		<SettingRow
			label="Restart Odin completely"
			description="Every new session fails to start (for example 'PTY process exited immediately')? This closes every open session and restarts Odin with fresh terminals. Sessions on a remote host keep running there."
		>
			<Button
				variant="outline"
				size="sm"
				className="h-8"
				disabled={restart.isPending}
				onClick={() => restart.mutate()}
			>
				Restart Completely
			</Button>
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
			description="A session started in a repo another one is working in waits in Queued until that one stops. Off (the default) lets them run side by side - each session works in its own worktree."
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

/**
 * Whether the board types /compact into a session the moment its card moves
 * into Idle, so the conversation is summarized while Claude's cache of it is
 * still warm.
 */
function IdleCompactRow() {
	const enabled = useIdleCompact((s) => s.enabled);
	const setEnabled = useIdleCompact((s) => s.setEnabled);
	return (
		<SettingRow
			label="Compact conversations moved to Idle"
			htmlFor="idle-compact"
			description="A session that moves to Idle - parked there, or waiting on others after Ping me - gets /compact right away: its next reply starts from the summary instead of re-reading the whole conversation. Claude's cache of a conversation goes cold after an hour, and the move is when you stop answering it, so the summary is written while reading it back is still cheap. Once per turn. A session whose drawer is open waits until you close it; Done and Needs you cards are left alone."
		>
			<Switch
				id="idle-compact"
				checked={enabled}
				onCheckedChange={(checked) => setEnabled(checked)}
			/>
		</SettingRow>
	);
}
