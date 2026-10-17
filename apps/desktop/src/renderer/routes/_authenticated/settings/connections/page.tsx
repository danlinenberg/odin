import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	EnterEnabledAlertDialogContent,
} from "@odin/ui/alert-dialog";
import { Button } from "@odin/ui/button";
import { Input } from "@odin/ui/input";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { cn } from "@odin/ui/utils";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { FaGithub, FaSlack } from "react-icons/fa";
import { LuCheck, LuCloudUpload, LuTrash2 } from "react-icons/lu";
import { SiClaude, SiClickup, SiGmail, SiJira, SiNotion } from "react-icons/si";
import {
	ConnectProvider,
	type Provider,
} from "renderer/components/ConnectProvider/ConnectProvider";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useInAppBrowser } from "renderer/stores/in-app-browser";
import { LINK_HOSTS } from "shared/in-odin-links";
import { PROFILE_RESTORE_MS } from "shared/odin-profile";
import { useClaudeSignIn } from "../../_odin/components/ClaudeSignInBanner";
import {
	useOdinFeeds,
	useSetSlackReaction,
} from "../../_odin/hooks/useOdinFeeds";
import { resetOdinFeeds } from "../../_odin/hooks/useOdinProfile";
import {
	SettingRow,
	SettingsPage,
	SettingsSection,
	StatusDot,
} from "../components/SettingsPage";

export const Route = createFileRoute("/_authenticated/settings/connections/")({
	component: ConnectionsSettings,
});

/**
 * Settings → Connections: the accounts Odin's own feeds run on (its Slack
 * reactions, Notion tasks, Jira and GitHub views) - not the cloud
 * organization integrations upstream Odin ships.
 *
 * Every row connects the same way: sign in. Nothing here takes a pasted token
 * and nothing reads a credential from the environment - see ConnectProvider.
 * Tokens go to this profile's slice of ~/.config/odin.json and stay in the
 * main process; this screen only ever sees an identity string.
 */

const META: Record<
	Provider,
	{ name: string; icon: React.ReactNode; description: string; help?: string }
> = {
	slack: {
		name: "Slack",
		icon: <FaSlack className="size-5" />,
		description:
			"Powers the Reactions tab - messages you react to with the emojis below.",
	},
	jira: {
		name: "Jira",
		icon: <SiJira className="size-5" />,
		description: "Issues assigned to you, in My Jira.",
	},
	github: {
		name: "GitHub",
		icon: <FaGithub className="size-5" />,
		description: "Your pull requests and review requests, in GitHub.",
	},
	notion: {
		name: "Notion",
		icon: <SiNotion className="size-5" />,
		description: "Rows from a Notion database, in the Notion tab.",
		help: "Odin reads only the Notion pages you share with it, plus their subpages. To add a teamspace, open its top page in Notion → ••• → Connections → Odin. Pages assigned to you and comments that tag you only show up from shared pages.",
	},
	gmail: {
		name: "Gmail",
		icon: <SiGmail className="size-5" />,
		description: "Unread mail, in the Email tab.",
	},
	clickup: {
		name: "ClickUp",
		icon: <SiClickup className="size-5" />,
		description: "Lets sessions read the ClickUp tasks they're given.",
	},
};

const ORDER: Provider[] = [
	"slack",
	"github",
	"jira",
	"notion",
	"gmail",
	"clickup",
];

function ConnectionsSettings() {
	const queryClient = useQueryClient();
	const status = electronTrpc.connections.status.useQuery(undefined, {
		refetchOnWindowFocus: false,
	});
	const [openRow, setOpenRow] = useState<Provider | null>(null);
	const [addingGithub, setAddingGithub] = useState(false);

	// Same drop a profile switch does: the rows already on screen came from the
	// account just signed out of, and `work.getConfig` still says it's
	// connected until something re-reads it. Resetting the feed routers takes
	// the disconnected source's items out of every tab (and out of All) and
	// leaves the ones still signed in to refetch. `status` is in that set, so
	// it re-probes on its own.
	const disconnect = electronTrpc.connections.disconnect.useMutation({
		onSuccess: () => resetOdinFeeds(queryClient),
		onError: (error) => toast.error(error.message),
	});

	return (
		<SettingsPage
			title="Connections"
			description="The accounts Odin reads your work from. You sign in to each one; the credentials stay on this Mac and never leave it."
		>
			<SettingsSection
				title="Profiles"
				description="Each profile has its own accounts - and its own board sessions, Slack queue and tasks. Only the active one shows anywhere in Odin."
			>
				<Profiles onSwitched={() => void status.refetch()} />
			</SettingsSection>

			<SettingsSection
				title="Accounts"
				description="Signed in for the active profile."
			>
				<ClaudeRow />
				{ORDER.map((provider) => {
					const row = status.data?.find((s) => s.provider === provider);
					const meta = META[provider];
					const isOpen = openRow === provider;
					return (
						<div
							key={provider}
							data-setting={meta.name}
							className="px-4 py-3.5"
						>
							<div className="flex items-start justify-between gap-6">
								<div className="flex items-start gap-3 min-w-0">
									<div className="flex size-8 shrink-0 items-center justify-center">
										{meta.icon}
									</div>
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
											<span className="text-sm font-medium">{meta.name}</span>
											<StatusDot
												loading={status.isLoading}
												configured={row?.configured ?? false}
												identity={row?.identity ?? null}
												error={row?.error ?? null}
											/>
										</div>
										<div className="text-xs text-muted-foreground mt-0.5">
											{meta.description}
										</div>
										{meta.help && (
											<div className="text-xs text-muted-foreground mt-1 max-w-[70ch]">
												{meta.help}
											</div>
										)}
									</div>
								</div>
								<div className="flex items-center gap-1 shrink-0">
									{provider === "github" && row?.configured && (
										<Button
											variant="outline"
											size="sm"
											onClick={() => setAddingGithub(!addingGithub)}
										>
											{addingGithub ? "Cancel" : "Add account"}
										</Button>
									)}
									<Button
										variant="outline"
										size="sm"
										onClick={() => setOpenRow(isOpen ? null : provider)}
									>
										{isOpen
											? "Cancel"
											: row?.configured
												? "Reconnect"
												: "Connect"}
									</Button>
									{row?.configured && (
										<Button
											variant="ghost"
											size="sm"
											disabled={disconnect.isPending}
											onClick={() => disconnect.mutate({ provider })}
										>
											Disconnect
										</Button>
									)}
								</div>
							</div>

							{provider === "slack" && row?.configured && !isOpen && (
								<SlackReactions />
							)}

							{provider === "github" && !!row?.accounts?.length && (
								<div className="mt-2 ml-11 space-y-1">
									{row.accounts.map((account) => (
										<div
											key={account.login}
											className="flex items-center gap-2 text-xs"
										>
											<span
												className={cn(
													"size-1.5 rounded-full",
													account.ok ? "bg-emerald-500" : "bg-red-500",
												)}
											/>
											<span>{account.login}</span>
											{!account.ok && (
												<span className="text-muted-foreground">
													token rejected - remove and add it again
												</span>
											)}
											<Button
												variant="ghost"
												size="sm"
												className="h-6 px-2 text-xs"
												disabled={disconnect.isPending}
												onClick={() =>
													disconnect.mutate({ provider, login: account.login })
												}
											>
												Remove
											</Button>
										</div>
									))}
								</div>
							)}

							{provider === "github" && addingGithub && (
								<div className="mt-3 ml-11 rounded-lg border bg-muted/30 p-3">
									<ConnectProvider
										provider="github"
										addAccount
										onConnected={() => {
											setAddingGithub(false);
											void status.refetch();
										}}
									/>
								</div>
							)}

							{isOpen && (
								<div className="mt-3 ml-11 rounded-lg border bg-muted/30 p-3">
									<ConnectProvider
										provider={provider}
										onConnected={() => {
											setOpenRow(null);
											void status.refetch();
										}}
									/>
								</div>
							)}
						</div>
					);
				})}
			</SettingsSection>

			<SettingsSection title="Phone">
				<PhoneRow />
			</SettingsSection>

			<SettingsSection title="Links">
				<OpenLinksInOdinRow />
			</SettingsSection>

			<SettingsSection title="Backup">
				<BackupRow />
			</SettingsSection>
		</SettingsPage>
	);
}

/**
 * The Claude account sessions run on - Mac-wide, not per profile, since it's
 * Claude Code's own login. Reconnect runs the same `claude auth login` as the
 * sign-in banner, e.g. to switch to another account or plan.
 */
function ClaudeRow() {
	const { status, login, failed, signedInAs } = useClaudeSignIn();
	const sendCode = electronTrpc.system.claudeLoginCode.useMutation();
	const [code, setCode] = useState("");
	const data = status.data;
	return (
		<div data-setting="Claude" className="px-4 py-3.5">
			<div className="flex items-start justify-between gap-6">
				<div className="flex items-start gap-3 min-w-0">
					<div className="flex size-8 shrink-0 items-center justify-center">
						<SiClaude className="size-5" />
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
							<span className="text-sm font-medium">Claude</span>
							<StatusDot
								loading={status.isLoading}
								configured={data?.signedIn !== false}
								identity={
									data?.signedIn === null
										? "Signed in outside Odin"
										: (data?.identity ?? "Signed in")
								}
								error={failed}
							/>
						</div>
						<div className="text-xs text-muted-foreground mt-0.5">
							The account your sessions run on.
						</div>
						{signedInAs !== null && (
							<div className="mt-1 flex items-center gap-1 text-xs font-medium text-success">
								<LuCheck className="size-3.5" />
								{signedInAs
									? `Signed in as ${signedInAs}`
									: "Signed in to Claude"}
							</div>
						)}
						{login.isPending && (
							<form
								className="mt-2 flex items-center gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									if (code.trim()) sendCode.mutate({ code });
									setCode("");
								}}
							>
								<span className="text-xs text-muted-foreground">
									Finish in your browser. If claude.ai shows a code, paste it:
								</span>
								<Input
									value={code}
									onChange={(event) => setCode(event.target.value)}
									placeholder="Paste code"
									className="h-8 w-40 text-xs"
								/>
							</form>
						)}
					</div>
				</div>
				<Button
					variant="outline"
					size="sm"
					disabled={login.isPending}
					onClick={() => login.mutate()}
				>
					{login.isPending
						? "Waiting…"
						: data?.signedIn === false
							? "Sign in"
							: "Reconnect"}
				</Button>
			</div>
		</div>
	);
}

/**
 * Not an account, but the same shape as one: a place Odin's data goes. The
 * daily copy itself runs in main (main/lib/backup-data.ts); this row only
 * shows where it landed and lets you force one.
 */
function BackupRow() {
	const status = electronTrpc.backup.status.useQuery();
	const run = electronTrpc.backup.run.useMutation({
		onSuccess: () => {
			void status.refetch();
			toast.success("Backed up to iCloud Drive");
		},
		onError: (error) => toast.error(error.message),
	});
	const disconnect = electronTrpc.backup.disconnect.useMutation({
		onSuccess: () => void status.refetch(),
		onError: (error) => toast.error(error.message),
	});
	const reveal = electronTrpc.backup.reveal.useMutation();
	const data = status.data;
	const identity = !data?.lastBackupAt
		? "Off until you back up once"
		: `Last ${new Date(data.lastBackupAt).toLocaleString([], {
				dateStyle: "medium",
				timeStyle: "short",
			})} · ${data.days} ${data.days === 1 ? "day" : "days"} kept`;
	return (
		<div data-setting="iCloud Drive" className="px-4 py-3.5">
			<div className="flex items-start justify-between gap-6">
				<div className="flex items-start gap-3 min-w-0">
					<div className="flex size-8 shrink-0 items-center justify-center">
						<LuCloudUpload className="size-5" />
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
							<span className="text-sm font-medium">iCloud Drive</span>
							<StatusDot
								loading={status.isLoading}
								configured={data?.available ?? false}
								identity={identity}
								error={null}
							/>
						</div>
						<div className="text-xs text-muted-foreground mt-0.5">
							Your board, briefs and scrollback, copied daily.
						</div>
						<div className="text-xs text-muted-foreground mt-1 max-w-[70ch]">
							{data?.available === false
								? "iCloud Drive is off, so nothing is copied. Turn it on in System Settings → Apple Account → iCloud."
								: !data?.lastBackupAt
									? "Back up now to turn on the daily copy. macOS asks once for access to iCloud Drive."
									: "Keeps 14 days in iCloud Drive → Odin Backups. To restore, quit Odin and copy a day's files back into ~/.odin."}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<Button
						variant="outline"
						size="sm"
						disabled={!data?.available || run.isPending}
						onClick={() => run.mutate()}
					>
						{run.isPending ? "Backing up…" : "Back up now"}
					</Button>
					{data?.lastBackupAt && (
						<Button variant="ghost" size="sm" onClick={() => reveal.mutate()}>
							Show
						</Button>
					)}
					{data?.lastBackupAt && (
						<Button
							variant="ghost"
							size="sm"
							disabled={disconnect.isPending}
							onClick={() => disconnect.mutate()}
						>
							Disconnect
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * The two emojis the Reactions tab watches for - the same values its header
 * chips edit. Slack names reactions, so these are names, not glyphs.
 */
function SlackReactions() {
	const { reactions } = useOdinFeeds();
	const setReaction = useSetSlackReaction();
	const fields = [
		{
			label: "Queue",
			hint: "Adds the message to the Reactions tab.",
			value: reactions.data?.reaction ?? "eyes",
			launch: false,
		},
		{
			label: "Queue and start",
			hint: "Also starts a session on it, no click needed.",
			value: reactions.data?.launchReaction ?? "robot_face",
			launch: true,
		},
	];
	const save = (raw: string, current: string, launch: boolean) => {
		const name = raw
			.trim()
			.replace(/^:+|:+$/g, "")
			.toLowerCase();
		if (name && name !== current) setReaction.mutate({ name, launch });
	};
	return (
		<div className="mt-3 ml-11 space-y-2">
			{fields.map((field) => (
				<div key={field.label} className="flex items-center gap-3 text-xs">
					<span className="w-28 shrink-0 font-medium">{field.label}</span>
					<Input
						// Re-mount on a new value so the field shows what was saved.
						key={field.value}
						defaultValue={field.value}
						aria-label={`${field.label} reaction`}
						onBlur={(e) =>
							save(e.currentTarget.value, field.value, field.launch)
						}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
						className="h-7 w-44 text-xs"
					/>
					<span className="text-muted-foreground">{field.hint}</span>
				</div>
			))}
		</div>
	);
}

/**
 * Profiles - one set of accounts each, and the work that belongs to them.
 *
 * It sits above the provider rows because it decides what they're describing:
 * every row below is the state of *this* profile's connection, and switching
 * re-probes the lot. Sessions, the Slack queue and my tasks follow the same
 * id, so switching here changes the whole app, not just these five rows.
 */
function daysLeft(deletedAt: number): string {
	const days = Math.max(
		1,
		Math.ceil((deletedAt + PROFILE_RESTORE_MS - Date.now()) / 86_400_000),
	);
	return days === 1 ? "1 more day" : `${days} more days`;
}

function Profiles({ onSwitched }: { onSwitched: () => void }) {
	const queryClient = useQueryClient();
	const profiles = electronTrpc.connections.profiles.useQuery();
	const [newName, setNewName] = useState("");
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

	const done = () => {
		void profiles.refetch();
		resetOdinFeeds(queryClient);
		onSwitched();
	};
	const fail = (error: { message: string }) => toast.error(error.message);

	const setActive = electronTrpc.connections.setActiveProfile.useMutation({
		onSuccess: done,
		onError: fail,
	});
	const create = electronTrpc.connections.createProfile.useMutation({
		onSuccess: () => {
			setNewName("");
			done();
		},
		onError: fail,
	});
	// A rename changes a label and nothing else - no need to drop any data.
	const rename = electronTrpc.connections.renameProfile.useMutation({
		onSuccess: () => void profiles.refetch(),
		onError: fail,
	});
	const remove = electronTrpc.connections.deleteProfile.useMutation({
		onSuccess: done,
		onError: fail,
	});
	const restore = electronTrpc.connections.restoreProfile.useMutation({
		onSuccess: () => void profiles.refetch(),
		onError: fail,
	});

	const rows = profiles.data?.profiles ?? [];
	const deleted = profiles.data?.deleted ?? [];
	const isLast = rows.length <= 1;
	const pending = rows.find((profile) => profile.id === confirmDelete);

	return (
		<>
			<div className="divide-y">
				{rows.map((profile) => (
					<div
						key={profile.id}
						className={cn(
							"group flex items-center gap-3 px-4 py-2",
							profile.active && "bg-muted/40",
						)}
					>
						<span
							className={cn(
								"size-2 shrink-0 rounded-full",
								profile.active ? "bg-success" : "bg-muted-foreground/30",
							)}
						/>
						{/* Uncontrolled, saved on blur: a controlled input would write
						    the config file (and re-read it) on every keystroke, and an
						    empty box mid-edit is a rejected name, not a rename. The row
						    reads as a label until you hover or focus it. */}
						<Input
							key={profile.name}
							defaultValue={profile.name}
							aria-label="Profile name"
							onBlur={(event) => {
								const name = event.target.value.trim();
								if (name && name !== profile.name) {
									rename.mutate({ id: profile.id, name });
								}
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
							className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 text-sm shadow-none hover:border-input focus-visible:border-input"
						/>
						<div className="flex w-24 shrink-0 justify-end">
							{profile.active ? (
								<span className="text-xs text-muted-foreground">Active</span>
							) : (
								<Button
									variant="outline"
									size="sm"
									className="h-7"
									disabled={setActive.isPending}
									onClick={() => setActive.mutate({ id: profile.id })}
								>
									Switch to
								</Button>
							)}
						</div>
						<Button
							variant="ghost"
							size="icon"
							className="size-7 shrink-0 text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
							disabled={isLast || remove.isPending}
							title="Delete this profile and the credentials it holds"
							aria-label={`Delete profile ${profile.name}`}
							onClick={() => setConfirmDelete(profile.id)}
						>
							<LuTrash2 className="size-4" />
						</Button>
					</div>
				))}
			</div>

			{deleted.map((profile) => (
				<div
					key={profile.id}
					className="flex items-center gap-3 border-t px-4 py-2"
				>
					<span className="size-2 shrink-0 rounded-full border border-muted-foreground/30" />
					<span className="min-w-0 flex-1 truncate px-2 text-sm text-muted-foreground">
						{profile.name}
					</span>
					<span className="shrink-0 text-xs text-muted-foreground">
						Deleted - restorable for {daysLeft(profile.deletedAt)}
					</span>
					<Button
						variant="outline"
						size="sm"
						className="h-7 shrink-0"
						disabled={restore.isPending}
						onClick={() => restore.mutate({ id: profile.id })}
					>
						Restore
					</Button>
				</div>
			))}

			<div className="flex items-center gap-2 bg-muted/20 px-4 py-2">
				<Input
					value={newName}
					placeholder="New profile name"
					aria-label="New profile name"
					onChange={(event) => setNewName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && newName.trim()) {
							create.mutate({ name: newName.trim() });
						}
					}}
					className="h-8 max-w-56 text-sm"
				/>
				<Button
					variant="outline"
					size="sm"
					className="h-8"
					disabled={!newName.trim() || create.isPending}
					onClick={() => create.mutate({ name: newName.trim() })}
				>
					Add profile
				</Button>
			</div>

			{/* Deleting keeps the profile restorable for 30 days. */}
			<AlertDialog
				open={pending !== undefined}
				onOpenChange={(open) => !open && setConfirmDelete(null)}
			>
				<EnterEnabledAlertDialogContent className="max-w-[340px] gap-0 p-0">
					<AlertDialogHeader className="px-4 pt-4 pb-2">
						<AlertDialogTitle className="font-medium">
							Delete profile "{pending?.name}"?
						</AlertDialogTitle>
						<AlertDialogDescription className="text-muted-foreground">
							Its Slack, Jira, GitHub and Notion sign-ins, board sessions and
							tasks are hidden. You can restore it here for 30 days. After that
							it is gone for good.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter className="flex-row justify-end gap-2 px-4 pt-2 pb-4">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-3 text-xs"
							onClick={() => setConfirmDelete(null)}
						>
							Cancel
						</Button>
						<AlertDialogAction
							variant="destructive"
							size="sm"
							className="h-7 px-3 text-xs"
							onClick={() => {
								if (pending) remove.mutate({ id: pending.id });
								setConfirmDelete(null);
							}}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</EnterEnabledAlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** Every provider names its link hosts, so a new one gets its switch below. */
const PROVIDER_LINK_HOSTS: Record<Provider, readonly string[]> = LINK_HOSTS;
const LINK_PROVIDERS = ORDER.filter((p) => PROVIDER_LINK_HOSTS[p].length > 0);
const linkSiteNames = LINK_PROVIDERS.map((p) => META[p].name);
const LINK_SITE_LIST = `${linkSiteNames.slice(0, -1).join(", ")} and ${linkSiteNames.at(-1)}`;

/**
 * Undoes "Always open links in your browser" from the in-app browser; while
 * it's on, each site can still send its own links to your browser.
 */
function OpenLinksInOdinRow() {
	const external = useInAppBrowser((state) => state.external);
	const browserSites = useInAppBrowser((state) => state.browserSites);
	return (
		<>
			<SettingRow
				label="Open links inside Odin"
				htmlFor="open-links-in-odin"
				description={`${LINK_SITE_LIST} links open in a panel over the page instead of another app; other links always go to your default browser. Off sends them all there.`}
			>
				<Switch
					id="open-links-in-odin"
					checked={!external}
					onCheckedChange={(inOdin) =>
						useInAppBrowser.setState({ external: !inOdin })
					}
				/>
			</SettingRow>
			{!external &&
				LINK_PROVIDERS.map((id) => (
					<SettingRow
						key={id}
						label={`${META[id].name} links`}
						htmlFor={`open-links-in-odin-${id}`}
					>
						<Switch
							id={`open-links-in-odin-${id}`}
							checked={!browserSites.includes(id)}
							onCheckedChange={(inOdin) =>
								useInAppBrowser.setState({
									browserSites: inOdin
										? browserSites.filter((site) => site !== id)
										: [...browserSites, id],
								})
							}
						/>
					</SettingRow>
				))}
		</>
	);
}

/**
 * Odin on your iPhone (main/lib/phone, docs/phone-encryption.md): an end to
 * end encrypted channel, on this Wi-Fi or through a relay. The QR code
 * carries Odin's public key and a one-time code: scanning it is the pairing.
 */
function PhoneRow() {
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
	const setRelay = electronTrpc.phone.setRelay.useMutation({
		onSuccess,
		onError,
	});
	const remove = electronTrpc.phone.remove.useMutation({ onSuccess, onError });
	const unpairAll = electronTrpc.phone.unpairAll.useMutation({
		onSuccess,
		onError,
	});
	const [relay, setRelayInput] = useState<string | null>(null);
	const data = status.data;
	const savedRelay = data?.relay ?? "";
	return (
		<>
			<SettingRow
				label="Phone access"
				htmlFor="phone-access"
				description="Open the board and answer sessions from the Odin iPhone app. End to end encrypted: on this Wi-Fi, or from anywhere through a relay you run."
			>
				<Switch
					id="phone-access"
					checked={data?.state === "on"}
					disabled={setEnabled.isPending}
					onCheckedChange={(enabled) => setEnabled.mutate({ enabled })}
				/>
			</SettingRow>
			{data?.state === "error" && (
				<div className="px-4 pb-3 text-xs text-danger select-text cursor-text">
					{data.error}
				</div>
			)}
			{data?.state === "on" && (
				<div className="flex items-start gap-4 px-4 pb-4">
					<img
						src={data.qr}
						alt="QR code that pairs the Odin iPhone app"
						className="size-36 shrink-0 rounded-md"
					/>
					<div className="min-w-0 space-y-2 text-xs text-muted-foreground">
						<div>
							Scan with the iPhone camera: it opens the Odin app and pairs it.
							Or paste this link into the app. The code in it works once, for 10
							minutes.
						</div>
						<div className="break-all font-mono select-text cursor-text">
							{data.link}
						</div>
					</div>
				</div>
			)}
			<SettingRow
				label="Relay"
				htmlFor="phone-relay"
				description={
					data?.state === "on" && data.relay
						? data.relayState === "connected"
							? "Connected. The relay forwards encrypted bytes only."
							: "Connecting to the relay..."
						: "Reach Odin away from this Wi-Fi: the wss:// address of a relay you run (packages/odin-relay). It can't read what it forwards."
				}
			>
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						setRelay.mutate({ relay: relay ?? savedRelay });
					}}
				>
					<Input
						id="phone-relay"
						value={relay ?? savedRelay}
						onChange={(event) => setRelayInput(event.target.value)}
						placeholder="wss://relay.example.com"
						className="w-64"
					/>
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={
							setRelay.isPending || relay === null || relay === savedRelay
						}
					>
						Save
					</Button>
				</form>
			</SettingRow>
			{data?.devices.map((device) => (
				<SettingRow
					key={device.key}
					label={device.name}
					description={`Paired ${new Date(device.added).toLocaleDateString()}`}
				>
					<Button
						variant="ghost"
						size="sm"
						disabled={remove.isPending}
						onClick={() => remove.mutate({ key: device.key })}
					>
						<LuTrash2 className="size-4" />
						Remove
					</Button>
				</SettingRow>
			))}
			{!!data?.devices.length && (
				<div className="px-4 pb-4">
					<Button
						variant="outline"
						size="sm"
						disabled={unpairAll.isPending}
						onClick={() => unpairAll.mutate()}
					>
						Unpair all phones
					</Button>
				</div>
			)}
		</>
	);
}
