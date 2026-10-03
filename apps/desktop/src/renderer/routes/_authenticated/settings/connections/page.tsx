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
import { cn } from "@odin/ui/utils";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { FaGithub, FaSlack } from "react-icons/fa";
import { LuCloudUpload, LuTrash2 } from "react-icons/lu";
import { SiGmail, SiJira, SiNotion } from "react-icons/si";
import {
	ConnectProvider,
	type Provider,
} from "renderer/components/ConnectProvider/ConnectProvider";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	useOdinFeeds,
	useSetSlackReaction,
} from "../../_odin/hooks/useOdinFeeds";
import { resetOdinFeeds } from "../../_odin/hooks/useOdinProfile";
import {
	SettingsPage,
	SettingsSection,
	StatusDot,
} from "../components/SettingsPage";

export const Route = createFileRoute("/_authenticated/settings/connections/")({
	component: ConnectionsSettings,
});

/**
 * Settings → Connections: the accounts Odin's own feeds run on (its Slack
 * reactions, Notion tasks, Jira and GitHub views) — not the cloud
 * organization integrations upstream Odin ships.
 *
 * Every row connects the same way: sign in. Nothing here takes a pasted token
 * and nothing reads a credential from the environment — see ConnectProvider.
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
			"Powers the Reactions tab — messages you react to with the emojis below.",
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
};

const ORDER: Provider[] = ["slack", "github", "jira", "notion", "gmail"];

function ConnectionsSettings() {
	const queryClient = useQueryClient();
	const status = electronTrpc.connections.status.useQuery(undefined, {
		refetchOnWindowFocus: false,
	});
	const [openRow, setOpenRow] = useState<Provider | null>(null);

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
				description="Each profile has its own accounts — and its own board sessions, Slack queue and tasks. Only the active one shows anywhere in Odin."
			>
				<Profiles onSwitched={() => void status.refetch()} />
			</SettingsSection>

			<SettingsSection
				title="Accounts"
				description="Signed in for the active profile."
			>
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

			<SettingsSection title="Backup">
				<BackupRow />
			</SettingsSection>
		</SettingsPage>
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
	const reveal = electronTrpc.backup.reveal.useMutation();
	const data = status.data;
	const identity = !data?.lastBackupAt
		? "No backup yet"
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
				</div>
			</div>
		</div>
	);
}

/**
 * The two emojis the Reactions tab watches for — the same values its header
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
 * Profiles — one set of accounts each, and the work that belongs to them.
 *
 * It sits above the provider rows because it decides what they're describing:
 * every row below is the state of *this* profile's connection, and switching
 * re-probes the lot. Sessions, the Slack queue and my tasks follow the same
 * id, so switching here changes the whole app, not just these five rows.
 */
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
	// A rename changes a label and nothing else — no need to drop any data.
	const rename = electronTrpc.connections.renameProfile.useMutation({
		onSuccess: () => void profiles.refetch(),
		onError: fail,
	});
	const remove = electronTrpc.connections.deleteProfile.useMutation({
		onSuccess: done,
		onError: fail,
	});

	const rows = profiles.data?.profiles ?? [];
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

			{/* Deleting drops this profile's stored credentials — no undo. */}
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
							Its Slack, Jira, GitHub and Notion sign-ins are removed from this
							machine, along with its board sessions and tasks. This can't be
							undone.
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
