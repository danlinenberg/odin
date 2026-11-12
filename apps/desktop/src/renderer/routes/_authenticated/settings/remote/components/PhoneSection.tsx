import { Button } from "@odin/ui/button";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { LuLock, LuServer, LuSmartphone, LuTrash2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { AWAY_TASKS } from "shared/away-tasks";
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
						// The smoke test pairs a phone of its own from it.
						data-pair-link={data.link}
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
			{data?.state === "on" && <HostNote />}
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

/**
 * The remote host needs no code of its own: Odin tells its phone server
 * which phones are paired here, and tells those phones how to reach it
 * (main/lib/remote-host/phone-host-sync).
 */
function HostNote() {
	const host = electronTrpc.phone.remoteHost.useQuery();
	if (!host.data) return null;
	return (
		<>
			<div className="flex items-center gap-3 border-t px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">
				<LuServer className="size-4 shrink-0" />
				<span>
					Phones paired here also reach the sessions on {host.data.name}, even
					with this Mac closed or asleep.
				</span>
			</div>
			<AwayTasksRow name={host.data.name} />
		</>
	);
}

/**
 * Tasks with the Mac closed (main/lib/remote-host/away): off by default,
 * since it keeps task prompts and the sessions' sign-ins on the host.
 */
function AwayTasksRow({ name }: { name: string }) {
	const remote = electronTrpc.remoteHost.get.useQuery();
	const set = electronTrpc.remoteHost.setAwayTasks.useMutation({
		onSuccess: () => void remote.refetch(),
		onError: (error) => toast.error(error.message),
	});
	const on = !!remote.data?.host?.awayTasks;
	return (
		<SettingRow
			label="Tasks with the Mac closed"
			htmlFor="phone-away-tasks"
			description={
				on
					? `The top ${AWAY_TASKS} of Next in line are kept on ${name}, so the phone lists them and Start runs one there while this Mac is asleep. The board picks it up when the Mac is back. Turn off to delete them from ${name}.`
					: `Off: with this Mac asleep the phone shows only the sessions on ${name}. On keeps the top of Next in line there, encrypted on the way and readable only by your user on ${name}, so the phone can start them.`
			}
		>
			<Switch
				id="phone-away-tasks"
				checked={on}
				disabled={set.isPending || !remote.data?.host?.on}
				onCheckedChange={(next) => set.mutate(next)}
			/>
		</SettingRow>
	);
}
