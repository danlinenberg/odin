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
import { useEffect, useState } from "react";
import { LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SettingRow, SettingsSection } from "../../components/SettingsPage";

interface TagPair {
	key: string;
	value: string;
}

const DEFAULT_REGION = "us-east-1";
// Radix Select can't hold "", and a tag's value can be empty.
const EMPTY = "__empty";

type ClaudeState = "checking" | { path: string | null } | { error: string };

/**
 * Settings > Sessions > Remote host: pick the tags a host must carry, then
 * pick a host. Only instances that match every tag are listed, and only one
 * with Claude found on it can be used. Its sessions run there in tmux.
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
	const renew = electronTrpc.remoteHost.renewClaudeToken.useMutation({
		onSuccess: refresh,
		onError,
	});
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
	const findClaude = electronTrpc.remoteHost.awsFindClaude.useMutation();
	const [claude, setClaude] = useState<Record<string, ClaudeState>>({});
	const check = async (id: string) => {
		setClaude((prev) => ({ ...prev, [id]: "checking" }));
		const result = await findClaude
			.mutateAsync({ ...target, id, user })
			.then((r) => ({ path: r.path }))
			.catch((error: Error) => ({ error: error.message }));
		setClaude((prev) => ({ ...prev, [id]: result }));
	};

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
			description="Run new sessions on an EC2 instance you created, so they keep going with this computer shut. Odin connects through AWS Systems Manager with your own AWS sign-in: the instance needs no open port, public IP or SSH key. Sessions there use your own Claude plan."
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
				const state = claude[instance.id];
				const found =
					state && state !== "checking" && "path" in state ? state.path : null;
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
									state === "checking"
										? "checking for Claude"
										: state && "error" in state
											? `Claude check failed: ${state.error}`
											: state && "path" in state
												? state.path
													? `Claude: ${state.path}`
													: "Claude not found"
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
						<Button
							size="sm"
							variant="outline"
							disabled={!instance.ssmOnline || state === "checking"}
							title={
								instance.ssmOnline
									? undefined
									: "SSM can't reach it - it must be running with the SSM agent online"
							}
							onClick={() => check(instance.id)}
						>
							Check Claude
						</Button>
						<Button
							size="sm"
							disabled={!found}
							title={
								found
									? undefined
									: "Check Claude first - only an instance with Claude on it can be used"
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
