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
		onSuccess: refresh,
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
	const [setupParts, setSetupParts] = useState<Set<SetupPartId>>(
		new Set(["instructions", "skills", "commands"]),
	);
	useEffect(() => {
		const saved = current?.host?.claudeSetup;
		if (saved?.length) setSetupParts(new Set(saved as SetupPartId[]));
	}, [current?.host?.claudeSetup]);
	const syncSetup = electronTrpc.remoteHost.syncClaudeSetup.useMutation({
		onSuccess: ({ bytes }) => {
			toast.success(`Synced to the host (${Math.round(bytes / 1024)} KB).`);
			void refresh();
		},
	});
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
		{ enabled: loaded && tags.length > 0, retry: false },
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
			.mutateAsync({ ...target, id, user })
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

	return (
		<SettingsSection
			title="Remote host"
			description="Run new sessions on an EC2 instance you created, so they keep going with this computer shut. Odin connects through AWS Systems Manager with your own AWS sign-in: the instance needs no open port, public IP or SSH key. Only code tasks go there - ones with a GitHub repo; Slack, Notion and Jira tasks stay on this computer, where your connectors are. Sessions there use your Claude plan."
		>
			{current?.host && (
				<SettingRow
					label={`Sessions start on ${current.host.name || current.host.instanceId}`}
					htmlFor="remote-host-on"
					description={
						current.host.on
							? `New sessions run on ${current.host.instanceId} as ${current.host.user}, in tmux, with repos cloned under ${current.host.reposRoot}.`
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
							? "Signed in with your Claude plan. The token stays encrypted on this computer; each session hands it to the host in memory, never on its disk."
							: "Turning the host on opens your browser once to approve Claude. Sessions there then bill your Claude plan, with no sign-in on the host."
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
						current.host.apiKeyFallback === true
							? "When a session there hits your plan's limit, it continues on your ANTHROPIC_API_KEY, billed per token, until the limit resets."
							: "Off: a session there that hits your plan's limit waits for it to reset."
					}
				>
					<Switch
						id="remote-host-api-key"
						checked={current.host.apiKeyFallback === true}
						disabled={setApiKeyFallback.isPending}
						onCheckedChange={(on) => setApiKeyFallback.mutate(on)}
					/>
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
							Copies the parts you pick from this computer's ~/.claude, so
							sessions on the host follow the same instructions and have the
							same skills and plugins. Never your login or accounts, your
							conversations or history. Sync again after you change them.
							{current.host.claudeSetupSyncedAt && (
								<span className="mt-1 block">
									Last synced{" "}
									{new Date(current.host.claudeSetupSyncedAt).toLocaleString()}.
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
									onCheckedChange={(on) =>
										setSetupParts((prev) => {
											const next = new Set(prev);
											if (on) next.add(id);
											else next.delete(id);
											return next;
										})
									}
								/>
								{label}
							</label>
						))}
						<Button
							size="sm"
							variant="outline"
							disabled={!setupParts.size || syncSetup.isPending}
							onClick={() =>
								syncSetup.mutate(
									SETUP_PARTS.map(([id]) => id).filter((id) =>
										setupParts.has(id),
									),
								)
							}
						>
							{syncSetup.isPending ? "Syncing..." : "Sync now"}
						</Button>
					</div>
				</SettingRow>
			)}
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
				label="SSH username"
				htmlFor="aws-user"
				description="The user sessions run as, and the one the Claude check runs as."
			>
				<Input
					id="aws-user"
					className="w-40"
					value={user}
					onChange={(event) => setUser(event.target.value.trim())}
				/>
			</SettingRow>
			<SettingRow
				label="Tags"
				stacked
				description="A host must carry all of these, for example Owner = your name."
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
						onValueChange={(value) => setNewValue(value === EMPTY ? "" : value)}
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
			{tags.length > 0 && !error && instances.data?.length === 0 && (
				<SettingRow
					label="No matching instances"
					description="No instance in this account and region carries all of these tags."
				/>
			)}
			{(instances.data ?? []).map((instance) => {
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
								disabled={giveAccess.isPending || instance.state !== "running"}
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
		</SettingsSection>
	);
}
