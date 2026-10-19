import {
	ODIN_AUTO_RENAME_SESSIONS_DEFAULT,
	ODIN_REPLY_TLDR_DEFAULT,
} from "@odin/shared/constants";
import { Button } from "@odin/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@odin/ui/select";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { createFileRoute } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type RemoteControlMode,
	useClaudeCommand,
} from "renderer/stores/claude-command";
import { useIdleClose } from "renderer/stores/idle-close";
import { useLaunchLimits } from "renderer/stores/launch-limits";
import type { LaunchLimits } from "shared/machine-load";
import {
	NumberSetting,
	SettingRow,
	SettingsPage,
	SettingsSection,
} from "../components/SettingsPage";
import { RemoteHostSection } from "./components/RemoteHostSection";

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
				<RemoteControlRow />
				<FullDiskAccessRow />
			</SettingsSection>

			<RemoteHostSection />

			<SettingsSection
				title="When they start"
				description="A new session waits in Idle → Queued until all of these allow it. Changes apply within 5 seconds."
			>
				<LaunchLimitRow
					id="launch-limit-host"
					field="hostCpuPercent"
					label="Hold new sessions when this Mac is"
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
					field="minFreeDiskPercent"
					label="Hold new sessions when free disk is under"
					description="Free space on the home disk, shown in the top bar. Each session takes a ~3 GB worktree, and a full disk also starves memory. 0 means no limit."
					min={0}
					max={50}
					step={1}
					unit="% free"
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
				<ReplyTldrRow />
				<IdleCloseRow />
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

/** `claude --remote-control '[Odin] <task title>'` on launch and Resume. */
function RemoteControlRow() {
	const mode = useClaudeCommand((s) => s.remoteControl);
	const setRemoteControl = useClaudeCommand((s) => s.setRemoteControl);
	return (
		<SettingRow
			label="Remote Control"
			htmlFor="remote-control"
			description={
				mode === "all"
					? "Every session shows up in claude.ai/code and the Claude app as [Odin] <task>. That is a lot of sessions in your Claude app - pick Selected sessions to choose them one by one."
					: mode === "selected"
						? "Turn it on for one session from its right-click menu or the Remote Control button in its drawer. It shows up in claude.ai/code and the Claude app as [Odin] <task>."
						: "Follow and answer sessions from claude.ai/code or the Claude app on your phone. Uses your claude.ai login, not a setup-token or API key from your shell."
			}
		>
			<Select
				value={mode}
				onValueChange={(value) => setRemoteControl(value as RemoteControlMode)}
			>
				<SelectTrigger id="remote-control" className="w-[180px]">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="off">Off</SelectItem>
					<SelectItem value="all">Every session</SelectItem>
					<SelectItem value="selected">Selected sessions</SelectItem>
				</SelectContent>
			</Select>
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

/** The chat view's TL;DR card on the latest reply, and the phone's. */
function ReplyTldrRow() {
	const utils = electronTrpc.useUtils();
	const { data: enabled, isLoading } =
		electronTrpc.settings.getOdinReplyTldr.useQuery();
	const setEnabled = electronTrpc.settings.setOdinReplyTldr.useMutation({
		onMutate: async ({ enabled }) => {
			await utils.settings.getOdinReplyTldr.cancel();
			const previous = utils.settings.getOdinReplyTldr.getData();
			utils.settings.getOdinReplyTldr.setData(undefined, enabled);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous !== undefined) {
				utils.settings.getOdinReplyTldr.setData(undefined, context.previous);
			}
		},
		onSettled: () => utils.settings.getOdinReplyTldr.invalidate(),
	});

	return (
		<SettingRow
			label="Sum up the latest reply"
			htmlFor="reply-tldr"
			description="After each turn, a TL;DR card on the reply says what the agent did, and a reply too long for the window folds under it with a Show full reply link. Off shows every reply whole; the brief for the card's hover and Catch up is still written."
		>
			<Switch
				id="reply-tldr"
				checked={enabled ?? ODIN_REPLY_TLDR_DEFAULT}
				onCheckedChange={(enabled) => setEnabled.mutate({ enabled })}
				disabled={isLoading || setEnabled.isPending}
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
