import { Button } from "@odin/ui/button";
import { Input } from "@odin/ui/input";
import { Switch } from "@odin/ui/switch";
import { useCallback } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useReminders } from "../../../../_odin/components/Reminders";
import {
	SettingRow,
	SettingsPage,
	SettingsSection,
} from "../../../components/SettingsPage";
import { VolumeDropdown } from "./components/VolumeDropdown";

export function RingtonesSettings() {
	const utils = electronTrpc.useUtils();
	const { data: isMutedData, isLoading: isMutedLoading } =
		electronTrpc.settings.getNotificationSoundsMuted.useQuery();
	const isMuted = isMutedData ?? false;

	const setMuted = electronTrpc.settings.setNotificationSoundsMuted.useMutation(
		{
			onMutate: async ({ muted }) => {
				await utils.settings.getNotificationSoundsMuted.cancel();
				const previous = utils.settings.getNotificationSoundsMuted.getData();
				utils.settings.getNotificationSoundsMuted.setData(undefined, muted);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getNotificationSoundsMuted.setData(
						undefined,
						context.previous,
					);
				}
			},
		},
	);

	const handleOpenSystemSettings = useCallback(() => {
		electronTrpcClient.notifications.openSystemSettings.mutate().catch(() => {
			// Nothing to recover: the pane either opened or the platform has none.
		});
	}, []);

	return (
		<SettingsPage
			title="Notifications"
			description="How Odin gets your attention: when a session finishes, and when a reminder or due date comes up."
		>
			<SettingsSection
				title="When a session finishes"
				description="A banner and a sound each time an agent session completes."
			>
				{/* Banners live in macOS: it keys the banner style, the icon and the
				    app name to the Odin bundle, so there is nothing to toggle here. */}
				<SettingRow
					label="Desktop banners"
					description="macOS decides whether banners appear, and shows them under Odin's icon and name."
				>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={handleOpenSystemSettings}
					>
						Open System Settings
					</Button>
				</SettingRow>
				<SettingRow label="Sound" htmlFor="notification-sounds">
					<Switch
						id="notification-sounds"
						checked={!isMuted}
						onCheckedChange={(enabled) => setMuted.mutate({ muted: !enabled })}
						disabled={isMutedLoading || setMuted.isPending}
					/>
				</SettingRow>
				{!isMuted && <VolumeDropdown />}
			</SettingsSection>

			<SettingsSection title="Reminders">
				<NotifyAtRow />
			</SettingsSection>
		</SettingsPage>
	);
}

/** When the day's reminder and due-date banner goes out. Next minute tick. */
function NotifyAtRow() {
	const notifyAt = useReminders((s) => s.notifyAt);
	const setNotifyAt = useReminders((s) => s.setNotifyAt);
	return (
		<SettingRow
			label="Notify at"
			htmlFor="reminder-notify-at"
			description={`When "Remind me" sessions and due dates notify, on their day. All of a day's reminders arrive as one notification. The board shows them from midnight.`}
		>
			<Input
				id="reminder-notify-at"
				type="time"
				defaultValue={notifyAt}
				className="w-28 tabular-nums"
				style={{ colorScheme: "dark" }}
				onChange={(event) => {
					if (event.target.value) setNotifyAt(event.target.value);
				}}
			/>
		</SettingRow>
	);
}
