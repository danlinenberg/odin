import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AssociateIamInstanceProfileCommand,
	DescribeInstancesCommand,
	DescribeLaunchTemplatesCommand,
	DescribeTagsCommand,
	EC2Client,
	type Filter,
	RunInstancesCommand,
	StartInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
	AddRoleToInstanceProfileCommand,
	AttachRolePolicyCommand,
	CreateInstanceProfileCommand,
	CreateRoleCommand,
	GetInstanceProfileCommand,
	IAMClient,
} from "@aws-sdk/client-iam";
import {
	DescribeInstanceInformationCommand,
	GetCommandInvocationCommand,
	SendCommandCommand,
	SSMClient,
} from "@aws-sdk/client-ssm";
import {
	hostNameProblem,
	hostPolicyArnProblem,
	packageNames,
} from "shared/host-setup";
import { hostServiceInstallScript } from "./host-service";
import { ghInstallScript } from "./session";
import { awsClientConfig } from "./ssm";

/**
 * Settings > Remote host > the instances: every EC2 instance in the account
 * and region you picked, narrowed by tags when you add some, and what Use
 * does to make one of them the host. AWS's SDK with the user's own profile
 * (SSO included), so nothing beyond Odin needs installing.
 */

export interface AwsTarget {
	profile?: string;
	region?: string;
}

export interface TagPair {
	key: string;
	value: string;
}

export interface TagChoice {
	key: string;
	values: string[];
}

export interface AwsInstance {
	id: string;
	name: string;
	type: string;
	state: string;
	privateIp: string | null;
	publicIp: string | null;
	/** SSM's agent on it is reporting in: Start, the Claude check and SSM access work. */
	ssmOnline: boolean;
}

/** Profile names in the AWS config and credentials files - section names, nothing more. */
export function profileNames(config: string, credentials: string): string[] {
	const names = new Set<string>();
	for (const [text, prefixed] of [
		[config, true],
		[credentials, false],
	] as const)
		for (const match of text.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)) {
			const section = (match[1] ?? "").trim();
			if (section === "default") names.add("default");
			else if (!prefixed) names.add(section);
			else if (section.startsWith("profile "))
				names.add(section.slice(8).trim());
		}
	return [...names].sort();
}

export function listAwsProfiles(home = os.homedir()): string[] {
	const read = (file: string | undefined, fallback: string) => {
		try {
			return fs.readFileSync(file || path.join(home, ".aws", fallback), "utf8");
		} catch {
			return "";
		}
	};
	return profileNames(
		read(process.env.AWS_CONFIG_FILE, "config"),
		read(process.env.AWS_SHARED_CREDENTIALS_FILE, "credentials"),
	);
}

/** Every key with its values across the account's instances; AWS's own `aws:` tags left out. */
export function tagChoices(describeTags: unknown): TagChoice[] {
	const tags =
		(describeTags as { Tags?: { Key?: string; Value?: string }[] } | null)
			?.Tags ?? [];
	const byKey = new Map<string, Set<string>>();
	for (const { Key, Value } of tags) {
		if (!Key || Key.startsWith("aws:")) continue;
		const values = byKey.get(Key) ?? new Set<string>();
		values.add(Value ?? "");
		byKey.set(Key, values);
	}
	return [...byKey]
		.map(([key, values]) => ({ key, values: [...values].sort() }))
		.sort((a, b) => a.key.localeCompare(b.key));
}

export async function listTagChoices(target: AwsTarget): Promise<TagChoice[]> {
	const ec2 = new EC2Client(awsClientConfig(target));
	const tags: { Key?: string; Value?: string }[] = [];
	let NextToken: string | undefined;
	do {
		const page = await ec2.send(
			new DescribeTagsCommand({
				Filters: [{ Name: "resource-type", Values: ["instance"] }],
				MaxResults: 1000,
				NextToken,
			}),
		);
		tags.push(...(page.Tags ?? []));
		NextToken = page.NextToken;
	} while (NextToken);
	return tagChoices({ Tags: tags });
}

/** One filter per picked tag: an instance must carry all of them; none lists every instance. Terminated ones never show. */
export function instanceFilters(tags: TagPair[]): Filter[] {
	return [
		{
			Name: "instance-state-name",
			Values: ["pending", "running", "stopping", "stopped"],
		},
		...tags.map(({ key, value }) => ({ Name: `tag:${key}`, Values: [value] })),
	];
}

interface Ec2Instance {
	InstanceId?: string;
	InstanceType?: string;
	State?: { Name?: string };
	PrivateIpAddress?: string;
	PublicIpAddress?: string;
	Tags?: { Key?: string; Value?: string }[];
}

export function toInstances(
	describeInstances: unknown,
	online: Set<string>,
): AwsInstance[] {
	const reservations =
		(describeInstances as { Reservations?: { Instances?: Ec2Instance[] }[] })
			?.Reservations ?? [];
	return reservations
		.flatMap((reservation) => reservation.Instances ?? [])
		.filter((instance): instance is Ec2Instance & { InstanceId: string } =>
			Boolean(instance.InstanceId),
		)
		.map((instance) => ({
			id: instance.InstanceId,
			name:
				instance.Tags?.find((tag) => tag.Key === "Name")?.Value ??
				instance.InstanceId,
			type: instance.InstanceType ?? "",
			state: instance.State?.Name ?? "unknown",
			privateIp: instance.PrivateIpAddress ?? null,
			publicIp: instance.PublicIpAddress ?? null,
			ssmOnline: online.has(instance.InstanceId),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The most instances the picker lists; tags and the search narrow a larger account. */
export const MAX_INSTANCES = 200;

export interface InstanceList {
	instances: AwsInstance[];
	/** The account has more than MAX_INSTANCES matching; the first by name are here. */
	truncated: boolean;
}

/**
 * SSM's ping status (Online, ConnectionLost, Inactive) for each of the ids
 * it knows; an instance that never registered with SSM is left out. The
 * filter takes 100 ids and a page holds 50, so it goes in chunks.
 */
async function ssmPing(
	ssm: SSMClient,
	ids: string[],
): Promise<Map<string, string>> {
	const status = new Map<string, string>();
	for (let at = 0; at < ids.length; at += 50) {
		const Values = ids.slice(at, at + 50);
		let NextToken: string | undefined;
		do {
			const page = await ssm
				.send(
					new DescribeInstanceInformationCommand({
						Filters: [{ Key: "InstanceIds", Values }],
						MaxResults: 50,
						NextToken,
					}),
				)
				.catch(() => null);
			for (const item of page?.InstanceInformationList ?? [])
				if (item.InstanceId) status.set(item.InstanceId, item.PingStatus ?? "");
			NextToken = page?.NextToken;
		} while (NextToken);
	}
	return status;
}

/** The tag that marks an instance as one for Odin: what the odin-host launch
 * template puts on the instances it makes, and the one tag to add to an instance
 * made any other way. Always required - the picker never lists an account's
 * other machines; the picked tags only narrow within these. */
export const HOST_TAG: TagPair = { key: "Odin", value: "host" };

/** HOST_TAG plus the picked tags, without a second copy of the Odin tag. */
export function hostFilters(tags: TagPair[]): TagPair[] {
	return [HOST_TAG, ...tags.filter(({ key }) => key !== HOST_TAG.key)];
}

/**
 * The instances in the account and region tagged Odin = host (HOST_TAG), so
 * any instance anyone made is there to Use once it carries that tag, narrowed
 * by the picked tags - by name, with whether SSM sees each. Beyond
 * MAX_INSTANCES the list is cut and says so.
 */
export async function listInstances(
	target: AwsTarget,
	tags: TagPair[],
): Promise<InstanceList> {
	const config = awsClientConfig(target);
	const ec2 = new EC2Client(config);
	const reservations: { Instances?: Ec2Instance[] }[] = [];
	let count = 0;
	let NextToken: string | undefined;
	do {
		const page = await ec2.send(
			new DescribeInstancesCommand({
				Filters: instanceFilters(hostFilters(tags)),
				NextToken,
			}),
		);
		for (const reservation of page.Reservations ?? []) {
			reservations.push(reservation);
			count += reservation.Instances?.length ?? 0;
		}
		NextToken = page.NextToken;
	} while (NextToken && count <= MAX_INSTANCES);
	const all = toInstances({ Reservations: reservations }, new Set());
	const instances = all.slice(0, MAX_INSTANCES);
	const ids = instances.map((instance) => instance.id);
	const ping = ids.length ? await ssmPing(new SSMClient(config), ids) : null;
	return {
		instances: instances.map((instance) => ({
			...instance,
			ssmOnline: ping?.get(instance.id) === "Online",
		})),
		truncated: all.length > MAX_INSTANCES,
	};
}

export async function startInstance(
	target: AwsTarget,
	id: string,
): Promise<void> {
	await new EC2Client(awsClientConfig(target)).send(
		new StartInstancesCommand({ InstanceIds: [id] }),
	);
}

const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LaunchTemplate {
	id: string;
	name: string;
}

/**
 * The account's launch templates for Odin hosts: the ones tagged Odin = host.
 * The account side (terraform) keeps one, odin-host, with the AMI, the
 * OdinSsmHost instance profile, the subnet, security group, disk and the
 * first-boot install of system tools - so New host needs nothing per instance.
 */
export async function listLaunchTemplates(
	target: AwsTarget,
): Promise<LaunchTemplate[]> {
	const ec2 = new EC2Client(awsClientConfig(target));
	const templates: LaunchTemplate[] = [];
	let NextToken: string | undefined;
	do {
		const page = await ec2.send(
			new DescribeLaunchTemplatesCommand({
				Filters: [{ Name: "tag:Odin", Values: ["host"] }],
				NextToken,
			}),
		);
		for (const template of page.LaunchTemplates ?? [])
			if (template.LaunchTemplateId)
				templates.push({
					id: template.LaunchTemplateId,
					name: template.LaunchTemplateName ?? template.LaunchTemplateId,
				});
		NextToken = page.NextToken;
	} while (NextToken);
	return templates.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Launches one instance from the template's default version, named, and
 * tagged with the picker's tags so the list above shows it (the name wins
 * over a Name tag among them). The disk gets the same tags. Returns its id;
 * it is still pending - see waitForHost.
 */
export async function launchHost(
	target: AwsTarget,
	templateId: string,
	name: string,
	tags: TagPair[],
): Promise<string> {
	const problem = hostNameProblem(name);
	if (problem) throw new Error(problem);
	const Tags = [
		{ Key: "Name", Value: name.trim() },
		...tags
			.filter(({ key }) => key !== "Name")
			.map(({ key, value }) => ({ Key: key, Value: value })),
	];
	const launched = await new EC2Client(awsClientConfig(target)).send(
		new RunInstancesCommand({
			LaunchTemplate: { LaunchTemplateId: templateId, Version: "$Default" },
			MinCount: 1,
			MaxCount: 1,
			TagSpecifications: [
				{ ResourceType: "instance", Tags },
				{ ResourceType: "volume", Tags },
			],
		}),
	);
	const id = launched.Instances?.[0]?.InstanceId;
	if (!id) throw new Error("EC2 did not say which instance it launched.");
	return id;
}

/** How long waitForHost waits, and how; tests make it instant. */
export interface WaitOptions {
	/** Between two looks, ms. */
	every?: number;
	/** In all, ms. */
	limit?: number;
	sleep?: (ms: number) => Promise<void>;
	/** Right after StartInstances: a stale "stopped" reading then is not a stop, so it is waited out. */
	afterStart?: boolean;
}

/**
 * Why SSM does not see a running instance, most often: no way out to
 * Systems Manager, or no agent. The wait's timeout says so.
 */
export const SSM_UNSEEN =
	"Usually the instance has no outbound HTTPS to Systems Manager - it needs a public IP, a NAT gateway or a VPC endpoint for ssm, ssmmessages and ec2messages - or no SSM agent: Ubuntu and Amazon Linux images have it, other images need it installed.";

/**
 * Waits for a launched or started instance to be running and then for its
 * SSM agent to report in (a minute or two after boot), when setup can reach
 * it. Looks every 10 seconds for 10 minutes, then gives up saying how far it
 * got and, with SSM the holdup, what is usually wrong. An instance that stops
 * or terminates meanwhile fails at once.
 */
export async function waitForHost(
	target: AwsTarget,
	id: string,
	options: WaitOptions = {},
): Promise<void> {
	const every = options.every ?? 10_000;
	const limit = options.limit ?? 600_000;
	const sleep = options.sleep ?? delay;
	const gone = options.afterStart
		? ["shutting-down", "terminated"]
		: ["shutting-down", "terminated", "stopping", "stopped"];
	const config = awsClientConfig(target);
	const ec2 = new EC2Client(config);
	const ssm = new SSMClient(config);
	let state = "pending";
	for (let waited = 0; waited < limit; waited += every) {
		if (waited > 0) await sleep(every);
		if (state !== "running") {
			// A just-launched id is unknown to DescribeInstances for a few seconds.
			const described = await ec2
				.send(new DescribeInstancesCommand({ InstanceIds: [id] }))
				.catch(() => null);
			state =
				described?.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? state;
			if (gone.includes(state)) throw new Error(`The host is ${state}.`);
			if (state !== "running") continue;
		}
		if ((await ssmPing(ssm, [id])).get(id) === "Online") return;
	}
	const minutes = Math.round(limit / 60_000);
	throw new Error(
		state === "running"
			? `The host is running, but SSM did not see it in ${minutes} minutes. ${SSM_UNSEEN}`
			: `The host did not start in ${minutes} minutes; it is ${state}.`,
	);
}

/** Single-quote for the remote shell. */
const sh = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * What a host needs for Odin's sessions, installed when missing - run by SSM
 * as root, so it needs no sudo: tmux, git, curl and python3 from the
 * system's package manager, then the packages from Settings (`packages`,
 * space-separated, see shared/host-setup - one install each, so one the
 * manager doesn't have costs only itself); the Odin user's own Linux user,
 * without sudo; Claude Code and the GitHub CLI into that user's own
 * ~/.local/bin. Safe to run again. Ends with what it found.
 */
export function setUpScript(user: string, packages = ""): string {
	const extra = packageNames(packages);
	const asUser = [
		'cd "$HOME"',
		'export PATH="$HOME/.local/bin:$PATH"',
		"command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1",
		ghInstallScript,
		'for t in claude gh tmux git; do echo "$t=$(command -v $t || echo missing)"; done',
	].join("\n");
	return [
		"export DEBIAN_FRONTEND=noninteractive",
		'pkg() { if command -v apt-get >/dev/null; then apt-get install -y -q "$@" || { apt-get update -q && apt-get install -y -q "$@"; }; elif command -v dnf >/dev/null; then dnf install -y -q "$@"; elif command -v yum >/dev/null; then yum install -y -q "$@"; fi; } >/dev/null 2>&1',
		"for p in tmux git curl python3; do command -v $p >/dev/null || pkg $p; done",
		...(extra.length
			? [`for p in ${extra.map(sh).join(" ")}; do pkg "$p"; done`]
			: []),
		`id ${sh(user)} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${sh(user)}`,
		hostServiceInstallScript(user),
		// Not sudo -i: it escapes each newline into a line continuation, which
		// glued the script's lines together (fifor ...).
		`sudo -u ${sh(user)} -H bash -lc ${sh(asUser)}`,
	].join("\n");
}

export interface HostTools {
	claude: string | null;
	gh: string | null;
	tmux: string | null;
	git: string | null;
}

/** `name=path` lines into paths, null for "missing". */
export function parseTools(output: string): HostTools {
	const found = Object.fromEntries(
		output
			.split("\n")
			.map((line) => line.trim().split("="))
			.filter((pair) => pair.length === 2)
			.map(([name, path]) => [name, path === "missing" ? null : path]),
	);
	return {
		claude: found.claude ?? null,
		gh: found.gh ?? null,
		tmux: found.tmux ?? null,
		git: found.git ?? null,
	};
}

/** Sets the instance up for Odin's sessions (see setUpScript). Needs SSM online. */
export async function setUpHost(
	target: AwsTarget,
	id: string,
	user: string,
	packages = "",
	sleep = delay,
): Promise<HostTools> {
	const ssm = new SSMClient(awsClientConfig(target));
	const sent = await ssm.send(
		new SendCommandCommand({
			InstanceIds: [id],
			DocumentName: "AWS-RunShellScript",
			Comment: "Odin: set up for sessions",
			TimeoutSeconds: 600,
			Parameters: { commands: [setUpScript(user, packages)] },
		}),
	);
	const commandId = sent.Command?.CommandId;
	if (!commandId) throw new Error("SSM did not accept the setup.");
	for (let attempt = 0; attempt < 300; attempt++) {
		await sleep(2_000);
		const result = await ssm
			.send(
				new GetCommandInvocationCommand({
					CommandId: commandId,
					InstanceId: id,
				}),
			)
			.catch(() => null);
		if (
			!result ||
			["Pending", "InProgress", "Delayed"].includes(result.Status ?? "")
		)
			continue;
		if (result.Status !== "Success")
			throw new Error(
				`Setup ended as ${result.Status}: ${(result.StandardErrorContent ?? "").slice(-300)}`,
			);
		return parseTools(result.StandardOutputContent ?? "");
	}
	throw new Error("Setup did not finish in 10 minutes.");
}

const SSM_POLICY = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore";
/** The role Odin makes for an instance that has none. */
const ODIN_ROLE = "OdinSsmHost";

const ignore = (name: string) => (error: unknown) => {
	if ((error as { name?: string }).name !== name) throw error;
};

/**
 * Lets SSM reach an instance, with the user's own AWS sign-in: the SSM policy
 * on the instance's role, or - with no role - an OdinSsmHost role and instance
 * profile attached to it. The host policy from Settings (`hostPolicyArn`,
 * see shared/host-setup), when there is one, goes on the same role beside
 * it. The instance's SSM agent then registers on its own, usually within
 * minutes. Returns what it did.
 */
export async function giveSsmAccess(
	target: AwsTarget,
	id: string,
	hostPolicyArn = "",
): Promise<string> {
	const problem = hostPolicyArnProblem(hostPolicyArn);
	if (problem) throw new Error(problem);
	const policies = [SSM_POLICY];
	if (hostPolicyArn.trim()) policies.push(hostPolicyArn.trim());
	const what =
		policies.length > 1 ? "SSM access and the host policy" : "SSM access";
	const config = awsClientConfig(target);
	const ec2 = new EC2Client(config);
	const iam = new IAMClient(config);
	// Attaching a policy a role already has changes nothing, so this is safe to run again.
	const attach = async (role: string) => {
		for (const PolicyArn of policies)
			await iam.send(
				new AttachRolePolicyCommand({ RoleName: role, PolicyArn }),
			);
	};
	const instance = (
		await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }))
	).Reservations?.[0]?.Instances?.[0];
	const profileArn = instance?.IamInstanceProfile?.Arn;
	if (profileArn) {
		const profile = await iam.send(
			new GetInstanceProfileCommand({
				InstanceProfileName: profileArn.split("/").pop(),
			}),
		);
		const role = profile.InstanceProfile?.Roles?.[0]?.RoleName;
		if (!role) throw new Error("The instance's profile has no role.");
		await attach(role);
		return `Added ${what} to the instance's role, ${role}.`;
	}
	await iam
		.send(
			new CreateRoleCommand({
				RoleName: ODIN_ROLE,
				Description:
					"Lets AWS Systems Manager reach instances Odin runs sessions on",
				AssumeRolePolicyDocument: JSON.stringify({
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Principal: { Service: "ec2.amazonaws.com" },
							Action: "sts:AssumeRole",
						},
					],
				}),
			}),
		)
		.catch(ignore("EntityAlreadyExistsException"));
	await attach(ODIN_ROLE);
	await iam
		.send(new CreateInstanceProfileCommand({ InstanceProfileName: ODIN_ROLE }))
		.catch(ignore("EntityAlreadyExistsException"));
	await iam
		.send(
			new AddRoleToInstanceProfileCommand({
				InstanceProfileName: ODIN_ROLE,
				RoleName: ODIN_ROLE,
			}),
		)
		.catch(ignore("LimitExceededException"));
	// A new instance profile takes a few seconds to be usable in EC2.
	for (let attempt = 0; ; attempt++) {
		try {
			await ec2.send(
				new AssociateIamInstanceProfileCommand({
					InstanceId: id,
					IamInstanceProfile: { Name: ODIN_ROLE },
				}),
			);
			return `Attached the ${ODIN_ROLE} role, with ${what}, to the instance.`;
		} catch (error) {
			if (attempt >= 11) throw error;
			await new Promise((resolve) => setTimeout(resolve, 5_000));
		}
	}
}

/** What Use is doing to an instance, as it goes. */
export type UseHostStep =
	| "checking"
	| "giving-access"
	| "starting"
	| "waiting"
	| "setting-up";

export interface UseHostOptions extends WaitOptions {
	/** Told each step as it begins. */
	onStep?: (step: UseHostStep) => void;
}

/** What every host gets at setup, from Settings (shared/host-setup). */
export interface HostSetup {
	hostPolicyArn?: string;
	hostPackages?: string;
}

/**
 * Makes an existing instance - anyone's, in any account the profile reaches -
 * ready to be the host, doing only what it still needs. SSM access when SSM
 * does not see it (giveSsmAccess, the host policy beside it; a policy a role
 * already has is attached again at no cost), then a start when it is stopped:
 * access first, so the agent registers at boot. Then the wait for it to run
 * and for SSM to see it, and the setup, which installs only what is missing -
 * a host that has Claude keeps it. An instance with no role that cannot be
 * given one fails at once; one with a role may be reached anyway, so that
 * failure is held and told only if SSM never sees it. Returns what setup
 * found, for the caller to pick the host with.
 */
export async function bringUpHost(
	target: AwsTarget,
	id: string,
	user: string,
	setup: HostSetup = {},
	options: UseHostOptions = {},
): Promise<{ id: string; tools: HostTools }> {
	const step = options.onStep ?? (() => {});
	step("checking");
	const config = awsClientConfig(target);
	const ec2 = new EC2Client(config);
	const instance = (
		await ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }))
	).Reservations?.[0]?.Instances?.[0];
	if (!instance) throw new Error(`There is no instance ${id} here.`);
	const state = instance.State?.Name ?? "unknown";
	if (["shutting-down", "terminated"].includes(state))
		throw new Error(`The instance is ${state}.`);
	if (state === "stopping")
		throw new Error("The instance is stopping; Use it once it has stopped.");
	const online =
		(await ssmPing(new SSMClient(config), [id])).get(id) === "Online";
	let accessProblem: string | null = null;
	if (!online) {
		step("giving-access");
		try {
			await giveSsmAccess(target, id, setup.hostPolicyArn);
		} catch (error) {
			if (!instance.IamInstanceProfile) throw error;
			accessProblem = error instanceof Error ? error.message : String(error);
		}
	}
	if (state === "stopped") {
		step("starting");
		await startInstance(target, id);
	}
	if (!online) {
		step("waiting");
		try {
			await waitForHost(target, id, {
				...options,
				afterStart: state === "stopped",
			});
		} catch (error) {
			if (!accessProblem) throw error;
			throw new Error(
				`${error instanceof Error ? error.message : String(error)} Giving it SSM access failed too: ${accessProblem}`,
			);
		}
	}
	step("setting-up");
	const tools = await setUpHost(
		target,
		id,
		user,
		setup.hostPackages,
		options.sleep,
	);
	return { id, tools };
}
