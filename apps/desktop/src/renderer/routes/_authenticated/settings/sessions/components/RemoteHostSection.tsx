import { Button } from "@odin/ui/button";
import { Input } from "@odin/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@odin/ui/select";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { useEffect, useRef, useState } from "react";
import { LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SettingRow, SettingsSection } from "../../components/SettingsPage";

interface TagPair {
	key: string;
	value: string;
}

const DEFAULT_REGION = "us-east-1";
/** What can be kept on the host (main/lib/remote-host/host-service HOST_CONNECTORS). */
const CONNECTORS = [
	["slack", "Slack"],
	["notion", "Notion"],
	["jira", "Jira"],
	["github", "GitHub"],
	["clickup", "ClickUp"],
] as const;
type HostConnectorId = (typeof CONNECTORS)[number][0];
/** Parts of ~/.claude the host can get (main/lib/remote-host/claude-sync). */
const SETUP_PARTS = [
	["instructions", "Instructions (CLAUDE.md)"],
	["skills", "Skills"],
	["commands", "Commands and agents"],
	["plugins", "Plugins"],
	["settings", "Settings and hooks"],
] as const;
type SetupPartId = (typeof SETUP_PARTS)[number][0];
// Radix Select can't hold "", and a tag's value can be empty.
const EMPTY = "__empty";

/** An instance's setup: running, what it found, or why it failed. */
type SetupState = "running" | { claude: string | null } | { error: string };

/**
 * Settings > Sessions > Remote host: pick the tags a host must carry, then
 * pick a host. Only instances that match every tag are listed; Set up installs
 * what sessions need on one, and its sessions then run there in tmux.
 */
export function RemoteHostSection() {
	const utils = electronTrpc.useUtils();
	const { data: current } = electronTrpc.remoteHost.get.useQuery();
	const refresh = () => utils.remoteHost.get.invalidate();
	// Turning the host on runs `claude setup-token` first when no token is saved.
	const onError = (error: { message: string }) => toast.error(error.message);
	const use = electronTrpc.remoteHost.set.useMutation({
		onSuccess: () => {
			setChangingHost(false);
			return refresh();
		},
		onError,
	});
	const setOn = electronTrpc.remoteHost.setOn.useMutation({
		onSuccess: refresh,
		onError,
	});
	const setApiKeyFallback =
		electronTrpc.remoteHost.setApiKeyFallback.useMutation({
			onSuccess: refresh,
			onError,
		});
	const setGithubOnHost = electronTrpc.remoteHost.setGithubOnHost.useMutation({
		onSuccess: refresh,
		onError,
	});
	const githubAccounts = current?.githubAccounts ?? [];
	const toggleGithubAccount = (login: string, on: boolean) =>
		setGithubOnHost.mutate(
			githubAccounts
				.filter((account) => (account.login === login ? on : account.onHost))
				.map((account) => account.login),
		);
	const renew = electronTrpc.remoteHost.renewClaudeToken.useMutation({
		onSuccess: refresh,
		onError,
	});
	// A switch flips at once; writing on the host (an SSM connection, about
	// 8 seconds) happens behind it. Flips made meanwhile go out as one write
	// when it lands; a failed write puts the switches back and says why.
	const [wanted, setWanted] = useState<string[] | null>(null);
	const wantedRef = useRef<string[] | null>(null);
	wantedRef.current = wanted;
	const setConnectors = electronTrpc.remoteHost.setConnectors.useMutation({
		onSettled: async (_data, error, sent) => {
			await refresh();
			const latest = wantedRef.current;
			if (error) setWanted(null);
			else if (latest && latest.join() !== sent.join())
				setConnectors.mutate(latest as HostConnectorId[]);
			else setWanted(null);
		},
	});
	const onHost = new Set(wanted ?? current?.host?.connectors ?? []);
	// Like the connectors: a switch flips at once and its part is copied to
	// the host behind it; flips made meanwhile go out as one sync.
	const [wantedSetup, setWantedSetup] = useState<SetupPartId[] | null>(null);
	const wantedSetupRef = useRef<SetupPartId[] | null>(null);
	wantedSetupRef.current = wantedSetup;
	const syncSetup = electronTrpc.remoteHost.syncClaudeSetup.useMutation({
		onSettled: async (_data, error, sent) => {
			await refresh();
			const latest = wantedSetupRef.current;
			if (error) setWantedSetup(null);
			else if (latest && latest.join() !== sent.join())
				syncSetup.mutate(latest);
			else setWantedSetup(null);
		},
	});
	const setupParts = new Set(
		wantedSetup ?? (current?.host?.claudeSetup as SetupPartId[]) ?? [],
	);
	const toggleSetupPart = (id: SetupPartId, on: boolean) => {
		const next = new Set(setupParts);
		if (on) next.add(id);
		else next.delete(id);
		const list = SETUP_PARTS.map(([part]) => part).filter((part) =>
			next.has(part),
		);
		setWantedSetup(list);
		if (!syncSetup.isPending) syncSetup.mutate(list);
	};
	const toggleConnector = (name: HostConnectorId, on: boolean) => {
		const next = new Set(onHost);
		if (on) next.add(name);
		else next.delete(name);
		const list = CONNECTORS.map(([id]) => id).filter((id) => next.has(id));
		setWanted(list);
		if (!setConnectors.isPending) setConnectors.mutate(list);
	};
	const signingIn =
		renew.isPending ||
		(setOn.isPending && setOn.variables === true && !current?.hasClaudeToken) ||
		(use.isPending && !current?.hasClaudeToken);

	const { data: saved } = electronTrpc.remoteHost.awsSettings.useQuery();
	const { data: profiles = [] } =
		electronTrpc.remoteHost.awsProfiles.useQuery();
	const save = electronTrpc.remoteHost.setAwsSettings.useMutation();

	const [profile, setProfile] = useState("");
	const [region, setRegion] = useState(DEFAULT_REGION);
	const [tags, setTags] = useState<TagPair[]>([]);
	const [user, setUser] = useState("ubuntu");
	const [loaded, setLoaded] = useState(false);
	// With a host in use, the picker (profile, region, user, tags, instances)
	// folds behind Change host - it only matters when choosing one.
	const [changingHost, setChangingHost] = useState(false);
	useEffect(() => {
		if (!saved || loaded) return;
		setProfile(saved.profile ?? "");
		setRegion(saved.region ?? DEFAULT_REGION);
		setTags(saved.tags ?? []);
		setLoaded(true);
	}, [saved, loaded]);

	const target = { profile: profile || undefined, region: region || undefined };
	const persist = (next: {
		profile?: string;
		region?: string;
		tags?: TagPair[];
	}) =>
		save.mutate({
			profile: (next.profile ?? profile) || undefined,
			region: (next.region ?? region) || undefined,
			tags: next.tags ?? tags,
		});

	const tagChoices = electronTrpc.remoteHost.awsTags.useQuery(target, {
		enabled: loaded,
		retry: false,
	});
	const instances = electronTrpc.remoteHost.awsInstances.useQuery(
		{ ...target, tags },
		{ enabled: loaded, retry: false },
	);
	const start = electronTrpc.remoteHost.awsStart.useMutation({
		onSuccess: () => {
			toast.success("Starting. It shows as running in about a minute.");
			instances.refetch();
		},
		onError: (error) => toast.error(error.message),
	});
	const setUp = electronTrpc.remoteHost.awsSetUp.useMutation();
	const [setups, setSetups] = useState<Record<string, SetupState>>({});
	const runSetUp = async (id: string) => {
		setSetups((prev) => ({ ...prev, [id]: "running" }));
		const result = await setUp
			.mutateAsync({ ...target, id })
			.then((tools) => ({ claude: tools.claude }))
			.catch((error: Error) => ({ error: error.message }));
		setSetups((prev) => ({ ...prev, [id]: result }));
	};
	const giveAccess = electronTrpc.remoteHost.awsGiveSsmAccess.useMutation({
		onSuccess: (done) => {
			toast.success(
				`${done} SSM usually reaches it within a few minutes; restarting the instance makes it quicker.`,
			);
			instances.refetch();
		},
		onError: (error) => toast.error(error.message),
	});

	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const values =
		tagChoices.data?.find((choice) => choice.key === newKey)?.values ?? [];
	const addTag = () => {
		if (!newKey || tags.some((t) => t.key === newKey && t.value === newValue))
			return;
		const next = [...tags, { key: newKey, value: newValue }];
		setTags(next);
		persist({ tags: next });
		setNewKey("");
		setNewValue("");
	};
	const removeTag = (tag: TagPair) => {
		const next = tags.filter((t) => t !== tag);
		setTags(next);
		persist({ tags: next });
	};

	const error = tagChoices.error ?? instances.error;
	// Every instance in the account and region, narrowed by the optional tags
	// (server side) and the search (here).
	const [search, setSearch] = useState("");
	const needle = search.trim().toLowerCase();
	const shownInstances = (instances.data ?? []).filter(
		(instance) =>
			!needle ||
			instance.name.toLowerCase().includes(needle) ||
			instance.id.toLowerCase().includes(needle),
	);

	return (
		<SettingsSection
			title="Remote host"
			description="Run new sessions on an EC2 instance you created, so they keep going with this computer shut. Odin connects through AWS Systems Manager with your own AWS sign-in: the instance needs no open port, public IP or SSH key. With it on, new sessions start there - except a Slack, Notion or Jira task whose connector isn't on the host (below), which stays here. Sessions there use your Claude plan."
		>
			{current?.host && (
				<SettingRow
					label={`Sessions start on ${current.host.name || current.host.instanceId}`}
					htmlFor="remote-host-on"
					description={
						current.host.on
							? `New sessions run on ${current.host.instanceId} as ${current.host.user}, in tmux, with repos cloned under ${current.host.reposRoot}.${current.host.adminUser ? "" : " Everyone on this instance shares that login: pick it again under Change host (Set up, then Use) to get your own user."}`
							: "Off: new sessions start on this computer."
					}
				>
					<Switch
						id="remote-host-on"
						checked={current.host.on}
						disabled={setOn.isPending}
						onCheckedChange={(on) => setOn.mutate(on)}
					/>
				</SettingRow>
			)}
			<SettingRow
				label="Claude sign-in"
				description={
					signingIn
						? "Approve Claude in the browser window that opened."
						: current?.hasClaudeToken
							? "Signed in with your Claude plan. The host gets its own sign-in, so it offers extra usage at a usage limit. Sign in again if a host session asks you to log in."
							: "Turning the host on opens your browser once to approve Claude. The host then signs in to your Claude plan on its own."
				}
			>
				{current?.hasClaudeToken && (
					<Button
						size="sm"
						variant="outline"
						disabled={signingIn}
						onClick={() => renew.mutate()}
					>
						Sign in again
					</Button>
				)}
			</SettingRow>
			{current?.host && (
				<SettingRow
					label="API key at the plan limit"
					htmlFor="remote-host-api-key"
					description={
						current.apiKeyFallback
							? "When a session there hits your plan's limit, it continues on your ANTHROPIC_API_KEY, billed per token, until the limit resets."
							: "Off: a session there that hits your plan's limit waits for it to reset."
					}
				>
					<Switch
						id="remote-host-api-key"
						checked={current.apiKeyFallback}
						disabled={setApiKeyFallback.isPending}
						onCheckedChange={(on) => setApiKeyFallback.mutate(on)}
					/>
				</SettingRow>
			)}
			{current?.host && githubAccounts.length > 0 && (
				<SettingRow
					label="GitHub accounts on the host"
					stacked
					description={
						<span className="select-text cursor-text">
							A session on the host signs in to GitHub as one of these: the
							account that owns the repo it works on when that account may go,
							else the main one. The GitHub connector there uses the same
							account. Its token reaches every repo the account can, and anyone
							with a shell on the instance can read a session's environment, so
							keep a personal account off a work host. A task on a repo owned by
							an account kept off the host starts on this computer instead.
						</span>
					}
				>
					<div className="flex flex-wrap items-center gap-4">
						{githubAccounts.map((account) => (
							<label
								key={account.login}
								htmlFor={`host-github-${account.login}`}
								className="flex items-center gap-2 text-sm"
							>
								<Switch
									id={`host-github-${account.login}`}
									checked={account.onHost}
									disabled={setGithubOnHost.isPending}
									onCheckedChange={(on) =>
										toggleGithubAccount(account.login, on)
									}
								/>
								{account.login}
								{account.main && (
									<span className="text-muted-foreground">(main)</span>
								)}
							</label>
						))}
					</div>
				</SettingRow>
			)}
			{current?.host && (
				<SettingRow
					label="Connectors on the host"
					stacked
					description={
						<span className="select-text cursor-text">
							Sessions on the host can use these with this computer asleep or
							closed. Their tokens are kept on the host, readable only by Odin's
							own service there - sessions use a connector but never see its
							token. Anyone who can open a shell on the instance in your AWS
							account can still read them, so keep a connector here only if that
							is only you. Gmail never goes to the host; turning the host off
							removes them all.
							{setConnectors.isPending && (
								<span className="mt-1 block">
									Saving on the host - the first time also installs Odin's
									service there.
								</span>
							)}
							{setConnectors.error && (
								<span className="mt-1 block text-destructive">
									{setConnectors.error.message}
								</span>
							)}
						</span>
					}
				>
					<div className="flex flex-wrap items-center gap-4">
						{CONNECTORS.map(([id, label]) => (
							<label
								key={id}
								htmlFor={`host-connector-${id}`}
								className="flex items-center gap-2 text-sm"
							>
								<Switch
									id={`host-connector-${id}`}
									checked={onHost.has(id)}
									onCheckedChange={(on) => toggleConnector(id, on)}
								/>
								{label}
							</label>
						))}
					</div>
				</SettingRow>
			)}
			{current?.host && (
				<SettingRow
					label="Claude setup on the host"
					stacked
					description={
						<span className="select-text cursor-text">
							Turning a part on copies it from this computer's ~/.claude to the
							host, so sessions there follow the same instructions and have the
							same skills and plugins. Turning one off stops copying it; what is
							on the host stays. Never your login or accounts, your
							conversations or history. Sync again after you change them here.
							{syncSetup.isPending && (
								<span className="mt-1 block">Copying to the host...</span>
							)}
							{current.host.claudeSetupSyncedAt && (
								<span className="mt-1 block">
									Last synced{" "}
									{new Date(current.host.claudeSetupSyncedAt).toLocaleString()}.
								</span>
							)}
							{!!current.host.claudeSetupDropped?.length && (
								<span className="mt-1 block">
									Left out on the host, because they need files it doesn't have:{" "}
									{current.host.claudeSetupDropped.join("; ")}.
								</span>
							)}
							{syncSetup.error && (
								<span className="mt-1 block text-destructive">
									{syncSetup.error.message}
								</span>
							)}
						</span>
					}
				>
					<div className="flex flex-wrap items-center gap-4">
						{SETUP_PARTS.map(([id, label]) => (
							<label
								key={id}
								htmlFor={`host-setup-${id}`}
								className="flex items-center gap-2 text-sm"
							>
								<Switch
									id={`host-setup-${id}`}
									checked={setupParts.has(id)}
									onCheckedChange={(on) => toggleSetupPart(id, on)}
								/>
								{label}
							</label>
						))}
						<Button
							size="sm"
							variant="outline"
							disabled={!setupParts.size || syncSetup.isPending}
							title="Copy them again, after you change them on this computer"
							onClick={() =>
								syncSetup.mutate(
									SETUP_PARTS.map(([id]) => id).filter((id) =>
										setupParts.has(id),
									),
								)
							}
						>
							{syncSetup.isPending ? "Syncing..." : "Sync again"}
						</Button>
					</div>
				</SettingRow>
			)}
			{current?.host && !changingHost ? (
				<SettingRow
					label="Host"
					description={`${current.host.name || current.host.instanceId} (${current.host.instanceId}), as ${current.host.user}${current.host.profile ? `, AWS profile ${current.host.profile}` : ""}.`}
				>
					<Button
						size="sm"
						variant="outline"
						onClick={() => setChangingHost(true)}
					>
						Change host
					</Button>
				</SettingRow>
			) : (
				<>
					<SettingRow
						label="AWS profile"
						description="From your AWS config. Leave on Default to use the default profile."
					>
						<Select
							value={profile || "__default"}
							onValueChange={(value) => {
								const next = value === "__default" ? "" : value;
								setProfile(next);
								persist({ profile: next });
							}}
						>
							<SelectTrigger className="w-64">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="__default">Default</SelectItem>
								{profiles.map((name) => (
									<SelectItem key={name} value={name}>
										{name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SettingRow>
					<SettingRow label="Region" htmlFor="aws-region">
						<Input
							id="aws-region"
							className="w-40"
							value={region}
							onChange={(event) => setRegion(event.target.value.trim())}
							onBlur={() => persist({ region })}
						/>
					</SettingRow>
					<SettingRow
						label="Instance login"
						htmlFor="aws-user"
						description={`The instance's own login with sudo: ubuntu on Ubuntu, ec2-user on Amazon Linux. Odin uses it only to set up and to keep your tokens. Your sessions run as your own user, ${current?.hostUser ?? "odin-<you>"}, so others on the same instance never share your files, Claude sign-in or tokens.`}
					>
						<Input
							id="aws-user"
							className="w-40"
							value={user}
							onChange={(event) => setUser(event.target.value.trim())}
						/>
					</SettingRow>
					<SettingRow
						label="Tags (optional)"
						stacked
						description="Optional: list only instances that carry all of these, for example Owner = your name."
					>
						<div className="flex flex-wrap items-center gap-1.5">
							{tags.map((tag) => (
								<span
									key={`${tag.key}=${tag.value}`}
									className="flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 font-mono text-xs"
								>
									{tag.key} = {tag.value || '""'}
									<button
										type="button"
										aria-label={`Remove tag ${tag.key}`}
										onClick={() => removeTag(tag)}
										className="text-muted-foreground hover:text-foreground"
									>
										<LuX className="size-3" />
									</button>
								</span>
							))}
							<Select
								value={newKey}
								onValueChange={(key) => {
									setNewKey(key);
									setNewValue("");
								}}
							>
								<SelectTrigger className="w-44">
									<SelectValue
										placeholder={tagChoices.isLoading ? "Loading tags" : "Tag"}
									/>
								</SelectTrigger>
								<SelectContent>
									{(tagChoices.data ?? []).map((choice) => (
										<SelectItem key={choice.key} value={choice.key}>
											{choice.key}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Select
								value={newValue === "" ? EMPTY : newValue}
								onValueChange={(value) =>
									setNewValue(value === EMPTY ? "" : value)
								}
								disabled={!newKey}
							>
								<SelectTrigger className="w-44">
									<SelectValue placeholder="Value" />
								</SelectTrigger>
								<SelectContent>
									{values.map((value) => (
										<SelectItem key={value} value={value || EMPTY}>
											{value || '""'}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								size="sm"
								variant="outline"
								disabled={!newKey}
								onClick={addTag}
							>
								Add
							</Button>
						</div>
					</SettingRow>
					{error && (
						<SettingRow
							label="AWS did not answer"
							description={
								<span className="select-text cursor-text">{error.message}</span>
							}
						/>
					)}
					{instances.data && !error && shownInstances.length === 0 && (
						<SettingRow
							label="No matching instances"
							description={
								search.trim()
									? "No instance matches the search."
									: tags.length
										? "No instance in this account and region carries all of these tags."
										: "No instance in this account and region."
							}
						/>
					)}
					<SettingRow
						label="Search"
						htmlFor="aws-search"
						description="By name or instance id."
					>
						<Input
							id="aws-search"
							className="w-64"
							placeholder="odin-remote, i-0a95..."
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
					</SettingRow>
					{shownInstances.map((instance) => {
						const host = instance.privateIp ?? instance.publicIp;
						const state = setups[instance.id];
						const found =
							state && state !== "running" && "claude" in state
								? state.claude
								: null;
						return (
							<SettingRow
								key={instance.id}
								label={instance.name}
								description={
									<span className="select-text cursor-text">
										{[
											instance.id,
											instance.type,
											instance.state,
											host,
											instance.ssmOnline ? "SSM online" : "SSM offline",
											state === "running"
												? "setting up - Claude, gh, tmux and git, a minute or two"
												: state && "error" in state
													? `Setup failed: ${state.error}`
													: state && "claude" in state
														? state.claude
															? "set up for sessions"
															: "setup could not install Claude"
														: null,
										]
											.filter(Boolean)
											.join(" - ")}
									</span>
								}
							>
								{instance.state === "stopped" && (
									<Button
										size="sm"
										variant="outline"
										disabled={start.isPending}
										onClick={() => start.mutate({ ...target, id: instance.id })}
									>
										Start
									</Button>
								)}
								{instance.ssmOnline ? (
									<Button
										size="sm"
										variant="outline"
										disabled={state === "running"}
										title="Installs what sessions need here - Claude, gh, tmux, git - when missing"
										onClick={() => runSetUp(instance.id)}
									>
										Set up
									</Button>
								) : (
									<Button
										size="sm"
										variant="outline"
										disabled={
											giveAccess.isPending || instance.state !== "running"
										}
										title="Gives AWS Systems Manager access to this instance through its IAM role, with your AWS sign-in"
										onClick={() =>
											giveAccess.mutate({ ...target, id: instance.id })
										}
									>
										Set up access
									</Button>
								)}
								<Button
									size="sm"
									disabled={!found}
									title={
										found
											? undefined
											: "Set it up first - sessions need Claude on it"
									}
									onClick={() =>
										use.mutate({
											...target,
											on: true,
											name: instance.name,
											instanceId: instance.id,
											user,
											reposRoot: "~/repos",
										})
									}
								>
									{current?.host?.instanceId === instance.id ? "In use" : "Use"}
								</Button>
							</SettingRow>
						);
					})}
				</>
			)}
		</SettingsSection>
	);
}
