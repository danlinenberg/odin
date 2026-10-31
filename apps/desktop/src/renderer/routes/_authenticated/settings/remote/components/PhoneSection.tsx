import { Button } from "@odin/ui/button";
import { Input } from "@odin/ui/input";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { useState } from "react";
import {
	LuBellRing,
	LuLock,
	LuServer,
	LuSmartphone,
	LuTrash2,
} from "react-icons/lu";
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
			{data?.state === "on" && <HostPairing />}
			{data?.state === "on" && <LockScreenPush />}
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
 * The remote host's own QR code: its phone server (main/lib/phone/host) is
 * set up there on the first click, and the phone pairs with it as with this
 * Mac. Then the phone reaches the sessions on the host with this Mac asleep.
 */
function HostPairing() {
	const host = electronTrpc.phone.remoteHost.useQuery();
	const pairing = electronTrpc.phone.hostPairing.useMutation();
	if (!host.data) return null;
	const name = host.data.name;
	return (
		<div className="flex gap-5 border-t px-4 py-4">
			{pairing.data ? (
				<img
					src={pairing.data.qr}
					alt={`QR code that pairs the Odin iPhone app with ${name}`}
					className="size-32 shrink-0 rounded-lg bg-white p-1.5"
				/>
			) : (
				<span className="flex size-32 shrink-0 items-center justify-center rounded-lg bg-secondary">
					<LuServer className="size-8 text-muted-foreground" />
				</span>
			)}
			<div className="flex min-w-0 flex-col gap-2">
				<div className="text-sm font-medium">Pair phone with {name}</div>
				<p className="text-[13px] leading-relaxed text-muted-foreground">
					Pair the phone with this Mac first, then scan this second code. With
					this Mac closed or asleep, the phone still lists the sessions on{" "}
					{name}, reads them and answers them.
				</p>
				{pairing.error && (
					<div className="text-xs text-danger select-text cursor-text">
						{pairing.error.message}
					</div>
				)}
				<div className="mt-auto">
					<Button
						size="sm"
						variant="secondary"
						disabled={pairing.isPending}
						onClick={() => pairing.mutate()}
					>
						{pairing.isPending
							? `Setting up ${name}...`
							: pairing.data
								? "New code"
								: "Show code"}
					</Button>
				</div>
			</div>
		</div>
	);
}

/**
 * The lock screen widget's live count (main/lib/phone/push.ts): Odin sends
 * the phone a silent push through Apple when a turn ends, signed with your
 * own APNs key. Without one, the widget updates when the app opens.
 */
function LockScreenPush() {
	const saved = electronTrpc.phone.pushKey.useQuery();
	const [file, setFile] = useState<{ name: string; key: string } | null>(null);
	const [keyId, setKeyId] = useState("");
	const [teamId, setTeamId] = useState("");
	const onSuccess = () => {
		setFile(null);
		void saved.refetch();
	};
	const save = electronTrpc.phone.setPushKey.useMutation({ onSuccess });
	const clear = electronTrpc.phone.clearPushKey.useMutation({ onSuccess });
	const pick = async (picked: File | undefined) => {
		if (!picked) return;
		setFile({ name: picked.name, key: await picked.text() });
		// Apple names the download AuthKey_<Key ID>.p8.
		const id = picked.name.match(/AuthKey_([A-Z0-9]{10})\.p8$/i)?.[1];
		if (id) setKeyId(id.toUpperCase());
	};
	return (
		<div className="flex gap-5 border-t px-4 py-4">
			<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
				<LuBellRing className="size-4" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<div className="text-sm font-medium">Lock screen widget</div>
				<p className="text-[13px] leading-relaxed text-muted-foreground">
					The Odin widget on the iPhone lock screen counts the sessions that
					ended in the last hour. With an APNs key from your Apple developer
					account (Certificates, IDs & Profiles, Keys), Odin updates it the
					moment a turn ends. Without one, it updates when you open the app. The
					push carries only end times, never a title.
				</p>
				{saved.data ? (
					<div className="flex items-center gap-3 text-[13px]">
						<span className="text-muted-foreground">
							Key {saved.data.keyId}, team {saved.data.teamId}
						</span>
						<Button
							size="sm"
							variant="ghost"
							disabled={clear.isPending}
							onClick={() => clear.mutate()}
						>
							Remove
						</Button>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="secondary" asChild>
							<label className="cursor-pointer">
								{file ? file.name : "Choose .p8 key"}
								<input
									type="file"
									accept=".p8"
									className="hidden"
									onChange={(event) => void pick(event.target.files?.[0])}
								/>
							</label>
						</Button>
						<Input
							value={keyId}
							onChange={(event) => setKeyId(event.target.value)}
							placeholder="Key ID"
							aria-label="Key ID"
							className="h-8 w-28"
						/>
						<Input
							value={teamId}
							onChange={(event) => setTeamId(event.target.value)}
							placeholder="Team ID"
							aria-label="Team ID"
							className="h-8 w-28"
						/>
						<Button
							size="sm"
							disabled={!file || !keyId || !teamId || save.isPending}
							onClick={() =>
								file && save.mutate({ keyId, teamId, key: file.key })
							}
						>
							Save
						</Button>
					</div>
				)}
				{save.error && (
					<div className="text-xs text-danger select-text cursor-text">
						{save.error.message}
					</div>
				)}
			</div>
		</div>
	);
}
