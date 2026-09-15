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
import { LuTrash2 } from "react-icons/lu";
import { SiJira, SiNotion } from "react-icons/si";
import {
	ConnectProvider,
	type Provider,
} from "renderer/components/ConnectProvider/ConnectProvider";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { resetOdinFeeds } from "../../_odin/hooks/useOdinProfile";

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
	{ name: string; icon: React.ReactNode; description: string }
> = {
	slack: {
		name: "Slack",
		icon: <FaSlack className="size-5" />,
		description: "Powers the Reactions tab — messages you marked :eyes:.",
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
	},
};

const ORDER: Provider[] = ["slack", "github", "jira", "notion"];

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
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Connections</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Accounts Odin reads your work from. You sign in to each one; the
					credentials are stored on this machine and never leave it.
				</p>
			</div>

			<Profiles onSwitched={() => void status.refetch()} />

			<DefaultRepo />

			<div className="space-y-1">
				{ORDER.map((provider) => {
					const row = status.data?.find((s) => s.provider === provider);
					const meta = META[provider];
					const isOpen = openRow === provider;
					return (
						<div key={provider} className="border-b last:border-b-0 py-3">
							<div className="flex items-center justify-between gap-8">
								<div className="flex items-center gap-3 min-w-0">
									<div className="flex size-8 shrink-0 items-center justify-center">
										{meta.icon}
									</div>
									<div className="min-w-0">
										<div className="text-sm font-medium">{meta.name}</div>
										<div className="text-xs text-muted-foreground mt-0.5 truncate">
											{meta.description}
										</div>
									</div>
								</div>
								<div className="flex items-center gap-3 shrink-0">
									<StatusDot
										loading={status.isLoading}
										configured={row?.configured ?? false}
										identity={row?.identity ?? null}
										error={row?.error ?? null}
									/>
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
			</div>
		</div>
	);
}

/**
 * The checkout a session starts in when nothing else names one — the board's
 * new-task input, "Start session", anything without a repo picked.
 *
 * It sits on this screen because Connections is Odin's settings home (the
 * other sections configure a workspace UI Odin doesn't use). Unlike the rows
 * below it isn't an account, so it's machine-wide rather than per-profile.
 */
function DefaultRepo() {
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
		<div className="mb-8 overflow-hidden rounded-lg border">
			<div className="border-b px-4 py-3">
				<div className="text-sm font-medium">Default repo</div>
				<p className="mt-1 text-xs text-muted-foreground">
					Where a session starts when no repo is picked. Unset falls back to the
					workspace you opened last.
				</p>
			</div>
			<div className="flex items-center gap-2 px-4 py-2">
				<code className="min-w-0 flex-1 select-text truncate rounded bg-muted px-2 py-1 text-xs">
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
		<div className="mb-8 overflow-hidden rounded-lg border">
			<div className="border-b px-4 py-3">
				<div className="text-sm font-medium">Profiles</div>
				<p className="mt-1 text-xs text-muted-foreground">
					Each profile has its own Slack, Jira, GitHub and Notion — and its own
					board sessions, Slack queue and tasks. Only the active one is shown
					anywhere in Odin.
				</p>
			</div>

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
								profile.active ? "bg-green-500" : "bg-muted-foreground/30",
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

			<div className="flex items-center gap-2 border-t bg-muted/20 px-4 py-2">
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
		</div>
	);
}

function StatusDot({
	loading,
	configured,
	identity,
	error,
}: {
	loading: boolean;
	configured: boolean;
	identity: string | null;
	error: string | null;
}) {
	if (loading)
		return <span className="text-xs text-muted-foreground">checking…</span>;
	const color = !configured
		? "bg-muted-foreground/30"
		: error
			? "bg-red-500"
			: "bg-green-500";
	const label = !configured
		? "Not connected"
		: error
			? `Failed: ${error}`
			: (identity ?? "Connected");
	return (
		<div className="flex items-center gap-1.5">
			<span className={cn("size-2 rounded-full", color)} />
			<span
				className={cn(
					"select-text cursor-text text-xs",
					error ? "text-red-500" : "text-muted-foreground",
				)}
			>
				{label}
			</span>
		</div>
	);
}
