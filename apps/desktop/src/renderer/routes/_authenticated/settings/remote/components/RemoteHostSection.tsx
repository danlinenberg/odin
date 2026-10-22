import { Button } from "@odin/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@odin/ui/collapsible";
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
import { HiChevronDown } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { hostPackagesProblem, hostPolicyArnProblem } from "shared/host-setup";
import { SettingRow, SettingsSection } from "../../components/SettingsPage";

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
 * Settings > Remote > Remote host: every instance tagged Odin = host in the
 * AWS profile and region, and Use on one of them -
 * which gives it SSM access, starts it and installs what sessions need,
 * whichever it still lacks, then picks it. Its sessions then run there in
 * tmux. docs/remote-host.md says how to make a host.
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
	const setCustomApiKey = electronTrpc.remoteHost.setCustomApiKey.useMutation({
		onSuccess: () => {
			setApiKeyDraft("");
			return refresh();
		},
		onError,
	});
	const [apiKeyDraft, setApiKeyDraft] = useState("");
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
	// A GitHub sign-in of the host's own, one account at a time: the device
	// flow's code shows in the row, and the poll runs on GitHub's interval
	// until the approval lands, the flow fails, or Cancel. Held in refs so
	// the effect depends on the code alone (as Connections does).
	const [hostSignIn, setHostSignIn] = useState<{
		login: string;
		deviceCode: string;
		userCode: string;
		verificationUri: string;
		intervalSeconds: number;
	} | null>(null);
	const startHostSignIn =
		electronTrpc.remoteHost.githubHostSignInStart.useMutation({
			onSuccess: (code, { login }) => setHostSignIn({ ...code, login }),
			onError,
		});
	const pollHostSignIn =
		electronTrpc.remoteHost.githubHostSignInPoll.useMutation();
	const pollHostSignInRef = useRef(pollHostSignIn);
	pollHostSignInRef.current = pollHostSignIn;
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	useEffect(() => {
		if (!hostSignIn) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = (delaySeconds: number) => {
			timer = setTimeout(async () => {
				if (cancelled) return;
				try {
					const result = await pollHostSignInRef.current.mutateAsync({
						deviceCode: hostSignIn.deviceCode,
						login: hostSignIn.login,
					});
					if (cancelled) return;
					if (result.state === "signed-in") {
						toast.success(
							`${result.login} is signed in on the host. It refreshes its own token there now.`,
						);
						setHostSignIn(null);
						void refreshRef.current();
						return;
					}
					tick(result.intervalSeconds ?? delaySeconds);
				} catch (error) {
					if (cancelled) return;
					toast.error(error instanceof Error ? error.message : String(error));
					setHostSignIn(null);
				}
			}, delaySeconds * 1000);
		};
		tick(hostSignIn.intervalSeconds);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [hostSignIn]);
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
	const toggleAllSetupParts = (on: boolean) =>
		syncSetup.mutate(on ? SETUP_PARTS.map(([part]) => part) : []);
	const toggleConnector = (name: HostConnectorId, on: boolean) => {
		const next = new Set(onHost);
		if (on) next.add(name);
		else next.delete(name);
		setConnectorList(CONNECTORS.map(([id]) => id).filter((id) => next.has(id)));
	};
	const setConnectorList = (list: HostConnectorId[]) => {
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
	const [user, setUser] = useState("ubuntu");
	// What every host gets at setup (shared/host-setup), saved with the picker's settings.
	const [hostPolicyArn, setHostPolicyArn] = useState("");
	const [hostPackages, setHostPackages] = useState("");
	const [loaded, setLoaded] = useState(false);
	// With a host in use, the picker (profile, region, user, instances)
	// folds behind Change host - it only matters when choosing one.
	const [changingHost, setChangingHost] = useState(false);
	useEffect(() => {
		if (!saved || loaded) return;
		setProfile(saved.profile ?? "");
		setRegion(saved.region ?? DEFAULT_REGION);
		setHostPolicyArn(saved.hostPolicyArn ?? "");
		setHostPackages(saved.hostPackages ?? "");
		setLoaded(true);
	}, [saved, loaded]);

	const target = { profile: profile || undefined, region: region || undefined };
	const persist = (next: {
		profile?: string;
		region?: string;
		hostPolicyArn?: string;
		hostPackages?: string;
	}) => {
		const policy = (next.hostPolicyArn ?? hostPolicyArn).trim();
		const packages = (next.hostPackages ?? hostPackages).trim();
		save.mutate({
			profile: (next.profile ?? profile) || undefined,
			region: (next.region ?? region) || undefined,
			tags: [],
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

	const instances = electronTrpc.remoteHost.awsInstances.useQuery(
		{ ...target, tags: [] },
		{ enabled: loaded, retry: false },
	);
	// Use on an instance: one call to the main process gives it SSM access,
	// starts it, waits for it and sets it up - whichever it still needs (up
	// to twenty minutes) - and it is then picked as the host. The main
	// process says which step it is on while that runs, so the step shows
	// again when this page is opened again meanwhile. One host at a time.
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

	const hostStep = electronTrpc.remoteHost.awsHostStep.useQuery(undefined, {
		enabled: loaded,
		refetchInterval: (query) =>
			bringUp.isPending || query.state.data ? 1000 : false,
	});
	/** A host under way, from here or a page opened before: every Use waits for it. */
	const busy = bringUp.isPending || use.isPending || !!hostStep.data;
	/** The step Use is on for this instance, to read on its button; null when it is not under way. */
	const stepOf = (id: string) =>
		hostStep.data?.action === "use" && hostStep.data.id === id
			? HOST_STEPS[hostStep.data.step]
			: bringUp.isPending && bringUp.variables?.id === id
				? HOST_STEPS.checking
				: null;

	const error = instances.error;
	const [advancedOpen, setAdvancedOpen] = useState(false);
	// Every Odin = host instance in the account and region, narrowed by the search.
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
			description="Run new sessions on an EC2 instance in your AWS account, so they keep going with this computer shut. Odin connects with your AWS sign-in over Systems Manager: no open port or SSH key."
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
							? `When a session there hits your plan's limit, it continues on ${current.customApiKeyEnd ? `your key ending ${current.customApiKeyEnd}` : "your ANTHROPIC_API_KEY"}, billed per token, until the limit resets.`
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
			{current?.host && current.apiKeyFallback && (
				<SettingRow
					label="Custom API key (optional)"
					htmlFor="remote-host-custom-key"
					description={
						current.customApiKeyEnd
							? `Saved, ending ${current.customApiKeyEnd}. Kept encrypted on this computer and sent to the host with each session.`
							: "Use this key instead of ANTHROPIC_API_KEY. Kept encrypted on this computer and sent to the host with each session."
					}
				>
					<div className="flex items-center gap-2">
						<Input
							id="remote-host-custom-key"
							type="password"
							autoComplete="off"
							className="w-56 font-mono text-xs"
							placeholder={
								current.customApiKeyEnd
									? `...${current.customApiKeyEnd}`
									: "sk-ant-..."
							}
							value={apiKeyDraft}
							onChange={(event) => setApiKeyDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && apiKeyDraft.trim())
									setCustomApiKey.mutate(apiKeyDraft);
							}}
						/>
						<Button
							size="sm"
							variant="outline"
							disabled={!apiKeyDraft.trim() || setCustomApiKey.isPending}
							onClick={() => setCustomApiKey.mutate(apiKeyDraft)}
						>
							Save
						</Button>
						{current.customApiKeyEnd && (
							<Button
								size="sm"
								variant="ghost"
								disabled={setCustomApiKey.isPending}
								onClick={() => setCustomApiKey.mutate("")}
							>
								Remove
							</Button>
						)}
					</div>
				</SettingRow>
			)}
			{current?.host && githubAccounts.length > 0 && (
				<SettingRow
					label="GitHub accounts on the host"
					stacked
					description={
						<span className="select-text cursor-text">
							Sessions on the host use the account that owns the repo, else the
							main one. Sign in on the host so pushes work with this computer
							shut. Anyone with a shell on the instance can use these tokens:
							keep personal accounts off a work host.
						</span>
					}
				>
					<div className="flex flex-col gap-2">
						{githubAccounts.map((account) => (
							<div
								key={account.login}
								className="flex flex-wrap items-center gap-3 text-sm"
							>
								<label
									htmlFor={`host-github-${account.login}`}
									className="flex items-center gap-2"
								>
									<Switch
										id={`host-github-${account.login}`}
										checked={account.onHost}
										disabled={setGithubOnHost.isPending || !!hostSignIn}
										onCheckedChange={(on) =>
											toggleGithubAccount(account.login, on)
										}
									/>
									{account.login}
									{account.main && (
										<span className="text-muted-foreground">(main)</span>
									)}
								</label>
								{account.onHost && hostSignIn?.login === account.login ? (
									<span className="select-text cursor-text text-muted-foreground">
										Enter{" "}
										<span className="font-mono text-foreground tracking-[.15em]">
											{hostSignIn.userCode}
										</span>{" "}
										at {hostSignIn.verificationUri} (opened in your browser),
										signed in as {account.login}.{" "}
										<button
											type="button"
											className="underline-offset-2 hover:underline"
											onClick={() => setHostSignIn(null)}
										>
											Cancel
										</button>
									</span>
								) : account.onHost ? (
									<>
										<span className="text-muted-foreground">
											{account.hostSignIn
												? "Signed in on the host."
												: "Uses this computer's token."}
										</span>
										<Button
											size="sm"
											variant="outline"
											disabled={
												!!hostSignIn ||
												startHostSignIn.isPending ||
												setGithubOnHost.isPending
											}
											onClick={() =>
												startHostSignIn.mutate({ login: account.login })
											}
										>
											{account.hostSignIn
												? "Sign in again"
												: "Sign in on the host"}
										</Button>
									</>
								) : null}
							</div>
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
							Usable by host sessions with this computer shut. Sessions never
							see the tokens, but anyone with a shell on the instance can read
							them. A task whose connector is off here starts on this computer.
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
						<AllSwitch
							id="host-connector-all"
							checked={CONNECTORS.every(([id]) => onHost.has(id))}
							onCheckedChange={(on) =>
								setConnectorList(on ? CONNECTORS.map(([id]) => id) : [])
							}
						/>
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
							Copies these parts of ~/.claude to the host. Never your login or
							history. Sync again after you change them.
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
								<details className="mt-1">
									<summary className="cursor-pointer">
										{current.host.claudeSetupDropped.length} hooks left out:
										they need files the host doesn't have
									</summary>
									<ul className="mt-1 space-y-0.5 font-mono text-xs">
										{current.host.claudeSetupDropped.map((hook) => (
											<li key={hook}>{hook}</li>
										))}
									</ul>
								</details>
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
						<AllSwitch
							id="host-setup-all"
							checked={SETUP_PARTS.every(([id]) => setupParts.has(id))}
							onCheckedChange={toggleAllSetupParts}
						/>
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
							label={search.trim() ? "No matching hosts" : "No hosts here yet"}
							description={
								search.trim()
									? "No host matches the search."
									: "Only instances tagged Odin = host are listed. docs/remote-host.md in the Odin repo says how to make one."
							}
						/>
					)}
					{(instances.data?.instances.length ?? 0) > 5 && (
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
					)}
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
					<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
						<CollapsibleTrigger asChild>
							<button
								type="button"
								className="flex items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
							>
								<HiChevronDown
									className={`size-3.5 transition-transform ${advancedOpen ? "" : "-rotate-90"}`}
								/>
								Advanced
							</button>
						</CollapsibleTrigger>
						<CollapsibleContent className="divide-y divide-border border-t border-border">
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
									onChange={(event) =>
										setHostPolicyArn(event.target.value.trim())
									}
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
						</CollapsibleContent>
					</Collapsible>
				</>
			)}
		</SettingsSection>
	);
}

/** The first switch in a group: on when every switch in it is, and flips them all. */
function AllSwitch({
	id,
	checked,
	onCheckedChange,
}: {
	id: string;
	checked: boolean;
	onCheckedChange: (on: boolean) => void;
}) {
	return (
		<label
			htmlFor={id}
			className="flex items-center gap-2 border-border border-r pr-4 font-medium text-sm"
		>
			<Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
			All
		</label>
	);
}
