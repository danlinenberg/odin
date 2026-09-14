import { Button } from "@odin/ui/button";
import { Label } from "@odin/ui/label";
import { Switch } from "@odin/ui/switch";
import { useCallback } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-items";
import { VolumeDropdown } from "./components/VolumeDropdown";

interface RingtonesSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

export function RingtonesSettings({ visibleItems }: RingtonesSettingsProps) {
	const showNotification = isItemVisible(
		SETTING_ITEM_ID.RINGTONES_NOTIFICATION,
		visibleItems,
	);

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

	const handleMutedToggle = (enabled: boolean) => {
		setMuted.mutate({ muted: !enabled });
	};

	const handleOpenSystemSettings = useCallback(() => {
		electronTrpcClient.notifications.openSystemSettings.mutate().catch(() => {
			// Nothing to recover: the pane either opened or the platform has none.
		});
	}, []);

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Notifications</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Banners and sounds for completed tasks
				</p>
			</div>

			<div className="space-y-6">
				{/* Banners live in macOS: it keys the banner style, the icon and the
				    app name to the Odin bundle, so there is nothing to toggle here. */}
				{showNotification && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label className="text-sm font-medium">Desktop banners</Label>
							<p className="text-xs text-muted-foreground">
								macOS decides whether banners appear and shows them under Odin's
								icon and name
							</p>
						</div>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={handleOpenSystemSettings}
						>
							Open System Settings
						</Button>
					</div>
				)}

				{/* Sound Toggle */}
				{showNotification && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label
								htmlFor="notification-sounds"
								className="text-sm font-medium"
							>
								Notification sounds
							</Label>
							<p className="text-xs text-muted-foreground">
								Play a sound when tasks complete
							</p>
						</div>
						<Switch
							id="notification-sounds"
							checked={!isMuted}
							onCheckedChange={handleMutedToggle}
							disabled={isMutedLoading || setMuted.isPending}
						/>
					</div>
				)}

				{/* Volume Dropdown */}
				{showNotification && !isMuted && <VolumeDropdown />}
			</div>
		</div>
	);
}
