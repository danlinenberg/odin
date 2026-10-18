import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DescribeInstancesCommand,
	DescribeTagsCommand,
	EC2Client,
	type Filter,
	StartInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
	DescribeInstanceInformationCommand,
	GetCommandInvocationCommand,
	SendCommandCommand,
	SSMClient,
} from "@aws-sdk/client-ssm";
import { awsClientConfig } from "./ssm";

/**
 * Settings > Remote server > AWS instances: the EC2 hosts that match the tags
 * you picked, and whether Claude is on them. AWS's SDK with the user's own
 * profile (SSO included), so nothing beyond Odin needs installing.
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

/** One filter per picked tag: an instance must carry all of them. Terminated ones never show. */
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

export async function listInstances(
	target: AwsTarget,
	tags: TagPair[],
): Promise<AwsInstance[]> {
	// No tags picked means "show nothing", not "show every instance in the account".
	if (tags.length === 0) return [];
	const ec2 = new EC2Client(awsClientConfig(target));
	const reservations: unknown[] = [];
	let NextToken: string | undefined;
	do {
		const page = await ec2.send(
			new DescribeInstancesCommand({
				Filters: instanceFilters(tags),
				NextToken,
			}),
		);
		reservations.push(...(page.Reservations ?? []));
		NextToken = page.NextToken;
	} while (NextToken);
	const instances = toInstances({ Reservations: reservations }, new Set());
	const ids = instances.map((instance) => instance.id);
	if (ids.length === 0) return instances;
	const info = await new SSMClient(awsClientConfig(target))
		.send(
			new DescribeInstanceInformationCommand({
				Filters: [{ Key: "InstanceIds", Values: ids }],
			}),
		)
		.catch(() => null);
	const online = new Set(
		(info?.InstanceInformationList ?? [])
			.filter((item) => item.PingStatus === "Online" && item.InstanceId)
			.map((item) => item.InstanceId as string),
	);
	return instances.map((instance) => ({
		...instance,
		ssmOnline: online.has(instance.id),
	}));
}

export async function startInstance(
	target: AwsTarget,
	id: string,
): Promise<void> {
	await new EC2Client(awsClientConfig(target)).send(
		new StartInstancesCommand({ InstanceIds: [id] }),
	);
}

/** Single-quote for the remote shell. */
const sh = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The shell line SSM runs as root: Claude as `user` sees it - on their PATH,
 * or the copy Odin installs into its own folder on the first connect.
 */
export function claudeCheckScript(user: string): string {
	return `sudo -iu ${sh(user)} bash -lc ${sh(
		'command -v claude || { [ -x "$HOME/.local/bin/claude" ] && echo "$HOME/.local/bin/claude"; } || true',
	)}`;
}

/** The path to `claude` on the instance, or null when it is not there. Needs SSM online. */
export async function findClaude(
	target: AwsTarget,
	id: string,
	user: string,
): Promise<string | null> {
	const ssm = new SSMClient(awsClientConfig(target));
	const sent = await ssm.send(
		new SendCommandCommand({
			InstanceIds: [id],
			DocumentName: "AWS-RunShellScript",
			Comment: "Odin: is Claude installed",
			Parameters: { commands: [claudeCheckScript(user)] },
		}),
	);
	const commandId = sent.Command?.CommandId;
	if (!commandId) throw new Error("SSM did not accept the check.");
	for (let attempt = 0; attempt < 30; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
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
			throw new Error(`The check ended as ${result.Status}.`);
		return result.StandardOutputContent?.trim().split("\n")[0] || null;
	}
	throw new Error("The check did not finish in 30 seconds.");
}
