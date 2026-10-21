import { Button } from "@odin/ui/button";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { LuLock, LuSmartphone, LuTrash2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SettingRow, SettingsSection } from "../../components/SettingsPage";

/**
 * Settings > Remote > Phone. Odin on your iPhone (main/lib/phone,
 * docs/phone-encryption.md): an end to end encrypted channel, on this Wi-Fi
 * or through a relay. The QR code carries Odin's public key and a one-time
 * code: scanning it is the pairing.
 */
export function PhoneSection() {
	// Polled: a phone that pairs appears, and the spent code is replaced.
	const status = electronTrpc.phone.status.useQuery(undefined, {
		refetchInterval: 5_000,
	});
	const onError = (error: { message: string }) => toast.error(error.message);
	const onSuccess = () => void status.refetch();
	const setEnabled = electronTrpc.phone.setEnabled.useMutation({
		onSuccess,
		onError,
	});
	const remove = electronTrpc.phone.remove.useMutation({ onSuccess, onError });
	const unpairAll = electronTrpc.phone.unpairAll.useMutation({
		onSuccess,
		onError,
	});
	const data = status.data;
	const devices = data?.devices ?? [];
	return (
		<SettingsSection
			title="Phone"
			description="The Odin iPhone app: the board and its sessions in your pocket."
		>
			<SettingRow
				label="Phone access"
				htmlFor="phone-access"
				description="See the board and answer sessions from the Odin iPhone app, on this Wi-Fi or away from it."
			>
				<Switch
					id="phone-access"
					checked={data?.state === "on"}
					disabled={setEnabled.isPending}
					onCheckedChange={(enabled) => setEnabled.mutate({ enabled })}
				/>
			</SettingRow>
			{data?.state === "error" && (
				<div className="px-4 py-3 text-xs text-danger select-text cursor-text">
					{data.error}
				</div>
			)}
			{data?.state === "on" && (
				<div className="flex gap-5 px-4 py-4">
					<img
						src={data.qr}
						alt="QR code that pairs the Odin iPhone app"
						className="size-32 shrink-0 rounded-lg bg-white p-1.5"
					/>
					<div className="flex min-w-0 flex-col gap-2">
						<div className="text-sm font-medium">Pair a phone</div>
						<ol className="list-decimal space-y-1 pl-4 text-[13px] leading-relaxed text-muted-foreground">
							<li>Open the Camera on your iPhone.</li>
							<li>Point it at this code.</li>
							<li>Tap Open in Odin. The code works once, for 10 minutes.</li>
						</ol>
						<div className="mt-auto flex items-center gap-1.5 text-xs text-muted-foreground">
							<LuLock className="size-3.5 shrink-0" />
							End to end encrypted. Not even Odin's relay can read it.
						</div>
					</div>
				</div>
			)}
			{devices.length > 0 && (
				<div className="px-4 py-3">
					<div className="mb-1 flex items-center justify-between">
						<span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
							Paired phones
						</span>
						<button
							type="button"
							disabled={unpairAll.isPending}
							onClick={() => unpairAll.mutate()}
							className="text-xs text-muted-foreground hover:text-danger"
						>
							Unpair all
						</button>
					</div>
					{devices.map((device) => (
						<div key={device.key} className="flex items-center gap-3 py-1.5">
							<span className="flex size-8 items-center justify-center rounded-md bg-secondary">
								<LuSmartphone className="size-4" />
							</span>
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm">{device.name}</div>
								<div className="text-xs text-muted-foreground">
									Paired{" "}
									{new Date(device.added).toLocaleDateString(undefined, {
										month: "short",
										day: "numeric",
									})}
								</div>
							</div>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`Remove ${device.name}`}
								title="Remove"
								disabled={remove.isPending}
								onClick={() => remove.mutate({ key: device.key })}
							>
								<LuTrash2 className="size-4" />
							</Button>
						</div>
					))}
				</div>
			)}
		</SettingsSection>
	);
}
