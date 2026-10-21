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
import {
	hostNameProblem,
	hostPackagesProblem,
	hostPolicyArnProblem,
} from "shared/host-setup";
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

/** An instance's last Use: what setup found, or why it failed. */
type UseState = { claude: string | null } | { error: string };
/** What a host under way is doing (the remote-host router's HostStep). */
const HOST_STEPS = {
	launching: "Launching...",
	checking: "Checking...",
	"giving-access": "Giving SSM access...",
	starting: "Starting...",
	waiting: "Waiting for the host...",
	"setting-up": "Setting up...",
} as const;

/**
 * Settings > Remote > Remote host: every instance in the AWS profile and
 * region, narrowed by tags when some are picked, and Use on one of them -
 * which gives it SSM access, starts it and installs what sessions need,
 * whichever it still lacks, then picks it. Its sessions then run there in
 * tmux. New host makes one from the account's launch template first.
 */
export function RemoteHostSection() {
	const utils = electronTrpc.useUtils();
	const { data: current } = electronTrpc.remoteHost.get.useQuery(undefined, {
		// A Claude setup sync runs in the main process and goes on when this
		// page is left; while one runs, watch for it to land.
		refetchInterval: (query) =>
			query.state.data?.claudeSetupSync.parts ? 1000 : false,
	});
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
	// Like the connectors, a switch flips at once and its part is copied to
	// the host behind it. The main process owns that copy: it goes on when
	// this page is left, flips made meanwhile go out as one sync when it
	// lands, and `get` shows it all (the parts under way, the ones queued,
	// why the last one failed) wherever this page is opened again.
	const syncSetup = electronTrpc.remoteHost.syncClaudeSetup.useMutation({
		onSettled: refresh,
		onError,
	});
	const setupSync = current?.claudeSetupSync;
	const syncingSetup = !!setupSync?.parts;
	const setupParts = new Set<SetupPartId>(
		setupSync?.next ??
			setupSync?.parts ??
			(current?.host?.claudeSetup as SetupPartId[] | undefined) ??
			[],
	);
	const toggleSetupPart = (id: SetupPartId, on: boolean) => {
		const next = new Set(setupParts);
		if (on) next.add(id);
		else next.delete(id);
		syncSetup.mutate(
			SETUP_PARTS.map(([part]) => part).filter((part) => next.has(part)),
		);
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
	const save = electronTrpc.remoteHost.setAwsSettings.useMutation({
		onSuccess: () => utils.remoteHost.awsSettings.invalidate(),
		onError,
	});

	const [profile, setProfile] = useState("");
	const [region, setRegion] = useState(DEFAULT_REGION);
	const [tags, setTags] = useState<TagPair[]>([]);
	const [user, setUser] = useState("ubuntu");
	// What every host gets at setup (shared/host-setup), saved with the picker's settings.
	const [hostPolicyArn, setHostPolicyArn] = useState("");
	const [hostPackages, setHostPackages] = useState("");
	const [loaded, setLoaded] = useState(false);
	// With a host in use, the picker (profile, region, user, tags, instances)
	// folds behind Change host - it only matters when choosing one.
	const [changingHost, setChangingHost] = useState(false);
	useEffect(() => {
		if (!saved || loaded) return;
		setProfile(saved.profile ?? "");
		setRegion(saved.region ?? DEFAULT_REGION);
		setTags(saved.tags ?? []);
		setHostPolicyArn(saved.hostPolicyArn ?? "");
		setHostPackages(saved.hostPackages ?? "");
		setLoaded(true);
	}, [saved, loaded]);

	const target = { profile: profile || undefined, region: region || undefined };
	const persist = (next: {
		profile?: string;
		region?: string;
		tags?: TagPair[];
		hostPolicyArn?: string;
		hostPackages?: string;
	}) => {
		const policy = (next.hostPolicyArn ?? hostPolicyArn).trim();
		const packages = (next.hostPackages ?? hostPackages).trim();
		save.mutate({
			profile: (next.profile ?? profile) || undefined,
			region: (next.region ?? region) || undefined,
			tags: next.tags ?? tags,
			// A field still holding a typo keeps what was saved until it is fixed.
			hostPolicyArn:
				(hostPolicyArnProblem(policy) ? saved?.hostPolicyArn : policy) ||
				undefined,
			hostPackages:
				(hostPackagesProblem(packages) ? saved?.hostPackages : packages) ||
				undefined,
		});
	};
	/** A host setup field on blur: a typo reads as one line and is not saved. */
	const saveHostSetup = (
		field: "hostPolicyArn" | "hostPackages",
		value: string,
	) => {
		const problem =
			field === "hostPolicyArn"
				? hostPolicyArnProblem(value)
				: hostPackagesProblem(value);
		if (problem) toast.error(problem);
		else persist({ [field]: value });
	};

	const tagChoices = electronTrpc.remoteHost.awsTags.useQuery(target, {
		enabled: loaded,
		retry: false,
	});
	const instances = electronTrpc.remoteHost.awsInstances.useQuery(
		{ ...target, tags },
		{ enabled: loaded, retry: false },
	);
	// Use on an instance: one call to the main process gives it SSM access,
	// starts it, waits for it and sets it up - whichever it still needs (up
	// to twenty minutes) - and it is then picked as the host. The main
	// process says which step it is on while that runs, so the step shows
	// again when this page is opened again meanwhile. New host shares that:
	// one host at a time.
	const [uses, setUses] = useState<Record<string, UseState>>({});
	const pickHost = (
		id: string,
		name: string,
		tools: { claude: string | null },
	) => {
		setUses((prev) => ({ ...prev, [id]: { claude: tools.claude } }));
		instances.refetch();
		if (!tools.claude) {
			toast.error("The host is up, but setup could not install Claude on it.");
			return;
		}
		// The host in use already: picking it again would drop its connectors and setup.
		if (current?.host?.instanceId === id) {
			refresh();
			return;
		}
		use.mutate({
			...target,
			on: true,
			name,
			instanceId: id,
			user,
			reposRoot: "~/repos",
		});
	};
	const bringUp = electronTrpc.remoteHost.awsUseHost.useMutation({
		onSuccess: ({ id, tools }) =>
			pickHost(
				id,
				instances.data?.instances.find((instance) => instance.id === id)
					?.name ?? id,
				tools,
			),
		onError: (error, sent) => {
			// The row says why, and Use stays there to try again once it is fixed.
			setUses((prev) => ({ ...prev, [sent.id]: { error: error.message } }));
			instances.refetch();
		},
	});

	// New host: an instance from the account's odin-host launch template,
	// launched, waited for and set up by one call to the main process.
	const templates = electronTrpc.remoteHost.awsLaunchTemplates.useQuery(
		target,
		{ enabled: loaded, retry: false },
	);
	const [templateId, setTemplateId] = useState("");
	const template =
		templates.data?.find((candidate) => candidate.id === templateId) ??
		(templates.data?.length === 1 ? templates.data[0] : undefined);
	const [newName, setNewName] = useState<string | null>(null);
	const hostName = newName ?? current?.hostUser ?? "odin-host";
	const nameProblem = hostNameProblem(hostName);
	const newHost = electronTrpc.remoteHost.awsNewHost.useMutation({
		onSuccess: ({ id, tools }, sent) => pickHost(id, sent.name, tools),
		onError: (error) => {
			// A host that launched but failed later is in the list, to Use.
			instances.refetch();
			toast.error(error.message);
		},
	});
	const hostStep = electronTrpc.remoteHost.awsHostStep.useQuery(undefined, {
		enabled: loaded,
		refetchInterval: (query) =>
			newHost.isPending || bringUp.isPending || query.state.data ? 1000 : false,
	});
	/** A host under way, from here or a page opened before: every Use and New host waits for it. */
	const busy =
		newHost.isPending || bringUp.isPending || use.isPending || !!hostStep.data;
	const launching = newHost.isPending || hostStep.data?.action === "new";
	/** The step Use is on for this instance, to read on its button; null when it is not under way. */
	const stepOf = (id: string) =>
		hostStep.data?.action === "use" && hostStep.data.id === id
			? HOST_STEPS[hostStep.data.step]
			: bringUp.isPending && bringUp.variables?.id === id
				? HOST_STEPS.checking
				: null;

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
	const shownInstances = (instances.data?.instances ?? []).filter(
		(instance) =>
			!needle ||
			instance.name.toLowerCase().includes(needle) ||
			instance.id.toLowerCase().includes(needle),
	);

	return (
		<SettingsSection
			title="Remote host"
			description="Run new sessions on an EC2 instance in your AWS account - one that is there already, whoever made it, or a new one - so they keep going with this computer shut. Odin connects through AWS Systems Manager with your own AWS sign-in: the instance needs no open port, public IP or SSH key. With it on, new sessions start there - except a Slack, Notion or Jira task whose connector isn't on the host (below), which stays here. Sessions there use your Claude plan."
		>
			{current?.host && (
				<SettingRow
					label={`Sessions start on ${current.host.name || current.host.instanceId}`}
					htmlFor="remote-host-on"
					description={
						current.host.on
							? `New sessions run on ${current.host.instanceId} as ${current.host.user}, in tmux, with repos cloned under ${current.host.reposRoot}.${current.host.adminUser ? "" : " Everyone on this instance shares that login: pick it again under Change host (Use) to get your own user."}`
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
							{syncingSetup && (
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
							{setupSync?.error && (
								<span className="mt-1 block text-destructive">
									{setupSync.error}
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
							disabled={!setupParts.size || syncingSetup}
							title="Copy them again, after you change them on this computer"
							onClick={() =>
								syncSetup.mutate(
									SETUP_PARTS.map(([id]) => id).filter((id) =>
										setupParts.has(id),
									),
								)
							}
						>
							{syncingSetup ? "Syncing..." : "Sync again"}
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
						label="Host policy (optional)"
						htmlFor="aws-host-policy"
						description="An IAM policy Use puts on the host's role beside SSM's, when it gives the host SSM access: what a plugin on the host needs, such as reading your secrets with the instance role."
					>
						<Input
							id="aws-host-policy"
							className="w-80 font-mono text-xs"
							placeholder="arn:aws:iam::123456789012:policy/odin-host"
							value={hostPolicyArn}
							onChange={(event) => setHostPolicyArn(event.target.value.trim())}
							onBlur={() => saveHostSetup("hostPolicyArn", hostPolicyArn)}
						/>
					</SettingRow>
					<SettingRow
						label="Packages (optional)"
						htmlFor="aws-host-packages"
						description="Installed on the host by Use, from its package manager, separated by spaces: the tools your plugins and skills run."
					>
						<Input
							id="aws-host-packages"
							className="w-80"
							placeholder="awscli jq mysql-client"
							value={hostPackages}
							onChange={(event) => setHostPackages(event.target.value)}
							onBlur={() => saveHostSetup("hostPackages", hostPackages)}
						/>
					</SettingRow>
					<SettingRow
						label="Tags (optional)"
						stacked
						description="With none, the instances tagged Odin = host are listed: the odin-host template tags its instances so, and an instance made any other way needs that one tag. With some, only the instances that carry all of them are listed instead, for example Owner = your name."
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
					{instances.data?.truncated && (
						<SettingRow
							label={`The first ${shownInstances.length} instances`}
							description="The account has more. Add a tag above to narrow the list."
						/>
					)}
					{shownInstances.map((instance) => {
						const host = instance.privateIp ?? instance.publicIp;
						const last = uses[instance.id];
						const step = stepOf(instance.id);
						const inUse = current?.host?.instanceId === instance.id;
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
											step
												? "Use is on it - a few minutes when it needs starting or access"
												: last && "error" in last
													? `Use failed: ${last.error}`
													: last && "claude" in last
														? last.claude
															? "set up for sessions"
															: "setup could not install Claude"
														: null,
										]
											.filter(Boolean)
											.join(" - ")}
									</span>
								}
							>
								<Button
									size="sm"
									disabled={busy}
									title={
										inUse
											? "Starts it if it is stopped and installs what is missing"
											: "Gives it SSM access, starts it and installs what sessions need - Claude, gh, tmux, git and the packages above - whichever it still lacks, then picks it"
									}
									onClick={() => bringUp.mutate({ ...target, id: instance.id })}
								>
									{step ?? (inUse ? "In use" : "Use")}
								</Button>
							</SettingRow>
						);
					})}
					<SettingRow
						label="New host"
						htmlFor="aws-new-host-name"
						description={
							templates.error ? (
								<span className="select-text cursor-text">
									{templates.error.message}
								</span>
							) : templates.data?.length === 0 ? (
								"No odin-host launch template in this account."
							) : (
								"An instance from the account's odin-host launch template, which fixes its image, role, network and disk: named, tagged like the list above, started, set up and picked as the host. About five minutes."
							)
						}
					>
						{!!templates.data?.length && (
							<>
								{templates.data.length > 1 && (
									<Select
										value={template?.id ?? ""}
										onValueChange={setTemplateId}
										disabled={launching}
									>
										<SelectTrigger className="w-44">
											<SelectValue placeholder="Template" />
										</SelectTrigger>
										<SelectContent>
											{templates.data.map((candidate) => (
												<SelectItem key={candidate.id} value={candidate.id}>
													{candidate.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
								<Input
									id="aws-new-host-name"
									className="w-44"
									value={hostName}
									disabled={launching}
									onChange={(event) => setNewName(event.target.value)}
								/>
								<Button
									size="sm"
									disabled={busy || !template || !!nameProblem}
									title={nameProblem ?? undefined}
									onClick={() =>
										template &&
										newHost.mutate({
											...target,
											templateId: template.id,
											name: hostName.trim(),
											tags,
										})
									}
								>
									{launching
										? HOST_STEPS[hostStep.data?.step ?? "launching"]
										: "New host"}
								</Button>
							</>
						)}
					</SettingRow>
				</>
			)}
		</SettingsSection>
	);
}
