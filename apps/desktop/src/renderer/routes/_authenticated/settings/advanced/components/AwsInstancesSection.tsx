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
import { useEffect, useState } from "react";
import { LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SettingRow, SettingsSection } from "../../components/SettingsPage";

interface TagPair {
	key: string;
	value: string;
}

/** What "Use" saves: an SSM connection to this instance, as this user. */
export interface PickedInstance {
	name: string;
	instanceId: string;
	username: string;
	profile: string | null;
	region: string | null;
}

const DEFAULT_REGION = "us-east-1";
// Radix Select can't hold "", and a tag's value can be empty.
const EMPTY = "__empty";
// An expired or missing AWS sign-in, as the CLI words it.
const SIGN_IN_ERROR =
	/sso|token has expired|unable to locate credentials|aws sso login/i;

type ClaudeState = "checking" | { path: string | null } | { error: string };

/**
 * Settings > Remote server > AWS instances: pick the tags a host must carry,
 * then pick a host. Only instances that match every tag are listed, and only
 * one with Claude found on it can be used.
 */
export function AwsInstancesSection({
	odinFolder,
	onUse,
}: {
	odinFolder: string;
	onUse: (instance: PickedInstance) => void;
}) {
	const { data: saved } = electronTrpc.remoteConnections.awsSettings.useQuery();
	const { data: profiles = [] } =
		electronTrpc.remoteConnections.awsProfiles.useQuery();
	const save = electronTrpc.remoteConnections.setAwsSettings.useMutation();

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

	const tagChoices = electronTrpc.remoteConnections.awsTags.useQuery(target, {
		enabled: loaded,
		retry: false,
	});
	const instances = electronTrpc.remoteConnections.awsInstances.useQuery(
		{ ...target, tags },
		{ enabled: loaded && tags.length > 0, retry: false },
	);
	const signIn = electronTrpc.remoteConnections.awsSignIn.useMutation({
		onSuccess: () => {
			tagChoices.refetch();
			instances.refetch();
		},
		onError: (error) => toast.error(`AWS sign-in failed: ${error.message}`),
	});
	const start = electronTrpc.remoteConnections.awsStart.useMutation({
		onSuccess: () => {
			toast.success("Starting. It shows as running in about a minute.");
			instances.refetch();
		},
		onError: (error) => toast.error(error.message),
	});
	const findClaude = electronTrpc.remoteConnections.awsFindClaude.useMutation();
	const [claude, setClaude] = useState<Record<string, ClaudeState>>({});
	const check = async (id: string) => {
		setClaude((prev) => ({ ...prev, [id]: "checking" }));
		const result = await findClaude
			.mutateAsync({ ...target, id, user, odinFolder })
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
			title="AWS instances"
			description="Pick a server from your AWS account instead of typing it. Only instances that carry every tag you pick are listed, and only one with Claude found on it can be used. Odin connects through AWS Systems Manager with your own AWS sign-in: the instance needs no open port, public IP or SSH key."
		>
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
				description="The user Odin logs in as, and the one the Claude check runs as."
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
				description="A host must carry all of these. For hosts built by the odin-remote Terraform root, pick Component = odin-remote."
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
				>
					{SIGN_IN_ERROR.test(error.message) && (
						<Button
							size="sm"
							variant="outline"
							disabled={signIn.isPending}
							onClick={() => signIn.mutate(target)}
						>
							{signIn.isPending ? "Approve in the browser" : "Sign in to AWS"}
						</Button>
					)}
				</SettingRow>
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
								onUse({
									name: instance.name,
									instanceId: instance.id,
									username: user,
									profile: profile || null,
									region: region || null,
								})
							}
						>
							Use
						</Button>
					</SettingRow>
				);
			})}
		</SettingsSection>
	);
}
