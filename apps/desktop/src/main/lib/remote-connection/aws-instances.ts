import { execWithShellEnv } from "lib/trpc/routers/workspaces/utils/shell-env";
import { remoteClaudeFallbackPath } from "./remote-agent-setup";

/**
 * Settings > Remote server > AWS instances: the EC2 hosts that match the tags
 * you picked, and whether Claude is on them. Runs the `aws` CLI with your own
 * sign-in, as the AWS sign-in button already does (terminal/aws-sso.ts).
 * ponytail: the CLI over the SDK - no new dependency, and SSO tokens are the
 * CLI's anyway. Move to the SDK if Odin ever signs in to AWS itself.
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

async function aws(target: AwsTarget, args: string[]): Promise<unknown> {
	const { stdout } = await execWithShellEnv(
		"aws",
		[
			...args,
			"--output",
			"json",
			...(target.profile ? ["--profile", target.profile] : []),
			...(target.region ? ["--region", target.region] : []),
		],
		{ timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
	);
	return stdout.trim() ? JSON.parse(stdout) : null;
}

export async function listAwsProfiles(): Promise<string[]> {
	const { stdout } = await execWithShellEnv(
		"aws",
		["configure", "list-profiles"],
		{ timeout: 15_000 },
	);
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
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
	return tagChoices(
		await aws(target, [
			"ec2",
			"describe-tags",
			"--filters",
			"Name=resource-type,Values=instance",
		]),
	);
}

/** One `tag:<key>=<value>` filter per pair: an instance must carry all of them. Terminated ones never show. */
export function instanceFilters(tags: TagPair[]): string[] {
	return [
		"Name=instance-state-name,Values=pending,running,stopping,stopped",
		...tags.map(({ key, value }) => `Name=tag:${key},Values=${value}`),
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
	const [instances, ssm] = await Promise.all([
		aws(target, [
			"ec2",
			"describe-instances",
			"--filters",
			...instanceFilters(tags),
		]),
		aws(target, ["ssm", "describe-instance-information"]).catch(() => null),
	]);
	const online = new Set(
		(
			(
				ssm as {
					InstanceInformationList?: {
						InstanceId?: string;
						PingStatus?: string;
					}[];
				} | null
			)?.InstanceInformationList ?? []
		)
			.filter((info) => info.PingStatus === "Online" && info.InstanceId)
			.map((info) => info.InstanceId as string),
	);
	return toInstances(instances, online);
}

export async function startInstance(
	target: AwsTarget,
	id: string,
): Promise<void> {
	await aws(target, ["ec2", "start-instances", "--instance-ids", id]);
}

/** Single-quote for the remote shell. */
const sh = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The shell line SSM runs as root: Claude as `user` sees it - on their PATH,
 * or the copy Odin installs into its own folder on the first connect.
 */
export function claudeCheckScript(user: string, odinFolder: string): string {
	const launcher = remoteClaudeFallbackPath(
		odinFolder.replace(/^~\//, "$HOME/"),
	);
	return `sudo -iu ${sh(user)} bash -lc ${sh(
		`command -v claude || { [ -x "${launcher}" ] && echo "${launcher}"; } || true`,
	)}`;
}

/** The path to `claude` on the instance, or null when it is not there. Needs SSM online. */
export async function findClaude(
	target: AwsTarget,
	id: string,
	user: string,
	odinFolder: string,
): Promise<string | null> {
	const sent = (await aws(target, [
		"ssm",
		"send-command",
		"--instance-ids",
		id,
		"--document-name",
		"AWS-RunShellScript",
		"--comment",
		"Odin: is Claude installed",
		"--parameters",
		JSON.stringify({ commands: [claudeCheckScript(user, odinFolder)] }),
	])) as { Command?: { CommandId?: string } };
	const commandId = sent.Command?.CommandId;
	if (!commandId) throw new Error("SSM did not accept the check.");
	// ponytail: 1s polls for 30s; the check itself is one `command -v`.
	for (let attempt = 0; attempt < 30; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const result = (await aws(target, [
			"ssm",
			"get-command-invocation",
			"--command-id",
			commandId,
			"--instance-id",
			id,
		]).catch(() => null)) as {
			Status?: string;
			StandardOutputContent?: string;
		} | null;
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
