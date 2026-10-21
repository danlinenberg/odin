import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The EC2, IAM and SSM clients, recording: every command sent, by name and
 * input, and the one answer giveSsmAccess reads from each - whether the
 * instance has a profile, and that profile's role. A test scripts other
 * answers through `answer`; undefined falls through to those.
 */
const sent: { name: string; input: unknown }[] = [];
let instanceProfileArn: string | undefined;
let answer: (name: string, input: unknown) => unknown = () => undefined;
class FakeClient {
	async send(command: { input: unknown }) {
		const name = command.constructor.name;
		sent.push({ name, input: command.input });
		const scripted = answer(name, command.input);
		if (scripted !== undefined) return scripted;
		if (name === "DescribeInstancesCommand")
			return {
				Reservations: [
					{
						Instances: [
							{
								InstanceId: "i-1",
								IamInstanceProfile: instanceProfileArn
									? { Arn: instanceProfileArn }
									: undefined,
							},
						],
					},
				],
			};
		if (name === "GetInstanceProfileCommand")
			return { InstanceProfile: { Roles: [{ RoleName: "web-role" }] } };
		return {};
	}
}
const realEc2 = await import("@aws-sdk/client-ec2");
mock.module("@aws-sdk/client-ec2", () => ({
	...realEc2,
	EC2Client: FakeClient,
}));
const realIam = await import("@aws-sdk/client-iam");
mock.module("@aws-sdk/client-iam", () => ({
	...realIam,
	IAMClient: FakeClient,
}));
const realSsm = await import("@aws-sdk/client-ssm");
mock.module("@aws-sdk/client-ssm", () => ({
	...realSsm,
	SSMClient: FakeClient,
}));

const {
	giveSsmAccess,
	instanceFilters,
	launchHost,
	listLaunchTemplates,
	parseTools,
	profileNames,
	setUpScript,
	tagChoices,
	toInstances,
	waitForHost,
} = await import("./aws-instances");
const { hostNameProblem } = await import("shared/host-setup");

const SSM_POLICY = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore";
const HOST_POLICY = "arn:aws:iam::123456789012:policy/odin-host";
const attached = () =>
	sent
		.filter((call) => call.name === "AttachRolePolicyCommand")
		.map((call) => call.input);

describe("aws-instances", () => {
	beforeEach(() => {
		sent.length = 0;
		answer = () => undefined;
	});

	test("tag choices group values by key and drop AWS's own tags", () => {
		expect(
			tagChoices({
				Tags: [
					{ Key: "Component", Value: "odin-remote" },
					{ Key: "Component", Value: "bastion" },
					{ Key: "Component", Value: "odin-remote" },
					{ Key: "aws:autoscaling:groupName", Value: "x" },
					{ Key: "Name", Value: "odin-remote" },
				],
			}),
		).toEqual([
			{ key: "Component", values: ["bastion", "odin-remote"] },
			{ key: "Name", values: ["odin-remote"] },
		]);
	});

	test("every picked tag is a filter, and terminated instances never show", () => {
		expect(
			instanceFilters([{ key: "Component", value: "odin-remote" }]),
		).toEqual([
			{
				Name: "instance-state-name",
				Values: ["pending", "running", "stopping", "stopped"],
			},
			{ Name: "tag:Component", Values: ["odin-remote"] },
		]);
	});

	test("profiles come from both AWS files, without the config file's prefix", () => {
		expect(
			profileNames(
				"[default]\nregion=us-east-1\n[profile dev]\n[sso-session x]\n",
				"[default]\n[ci-keys]\n",
			),
		).toEqual(["ci-keys", "default", "dev"]);
	});

	test("instances carry their Name tag and whether SSM sees them", () => {
		expect(
			toInstances(
				{
					Reservations: [
						{
							Instances: [
								{
									InstanceId: "i-2",
									InstanceType: "c8g.4xlarge",
									State: { Name: "stopped" },
								},
								{
									InstanceId: "i-1",
									InstanceType: "c8g.4xlarge",
									State: { Name: "running" },
									PrivateIpAddress: "10.1.0.5",
									Tags: [{ Key: "Name", Value: "odin-remote" }],
								},
							],
						},
					],
				},
				new Set(["i-1"]),
			),
		).toEqual([
			{
				id: "i-2",
				name: "i-2",
				type: "c8g.4xlarge",
				state: "stopped",
				privateIp: null,
				publicIp: null,
				ssmOnline: false,
			},
			{
				id: "i-1",
				name: "odin-remote",
				type: "c8g.4xlarge",
				state: "running",
				privateIp: "10.1.0.5",
				publicIp: null,
				ssmOnline: true,
			},
		]);
	});

	test("setup installs what is missing as root, makes the user's own Linux user, and Claude and gh as that user", () => {
		const script = setUpScript("odin-dan");
		expect(script).toContain(
			"for p in tmux git curl python3; do command -v $p >/dev/null || pkg $p; done",
		);
		expect(script).not.toContain('do pkg "$p"; done');
		expect(script).toContain(
			"id 'odin-dan' >/dev/null 2>&1 || useradd --create-home --shell /bin/bash 'odin-dan'",
		);
		expect(script).toContain("sudo -u 'odin-dan' -H bash -lc ");
		expect(script).toContain("https://claude.ai/install.sh");
	});

	test("the packages from Settings go in one at a time, quoted, as root, before the user's part", () => {
		const script = setUpScript(
			"odin-dan",
			" awscli jq  mysql-client mongosh\n",
		);
		const packages = script.indexOf(
			`for p in 'awscli' 'jq' 'mysql-client' 'mongosh'; do pkg "$p"; done`,
		);
		expect(packages).toBeGreaterThan(script.indexOf("for p in tmux git"));
		expect(packages).toBeLessThan(script.indexOf("id 'odin-dan'"));
		expect(packages).toBeLessThan(script.indexOf("sudo -u 'odin-dan'"));
	});

	test("a package name that is not one never reaches the host", () => {
		expect(() => setUpScript("odin-dan", "jq; rm -rf /")).toThrow(
			"Not a package name: jq;.",
		);
		expect(() => setUpScript("odin-dan", "--reinstall jq")).toThrow(
			"Not a package name: --reinstall.",
		);
	});

	test("setup's report becomes paths, missing ones null", () => {
		expect(
			parseTools(
				"claude=/home/u/.local/bin/claude\ngh=missing\ntmux=/usr/bin/tmux\ngit=/usr/bin/git\n",
			),
		).toEqual({
			claude: "/home/u/.local/bin/claude",
			gh: null,
			tmux: "/usr/bin/tmux",
			git: "/usr/bin/git",
		});
	});

	test("Set up access puts the host policy beside SSM's on the instance's own role", async () => {
		sent.length = 0;
		instanceProfileArn = "arn:aws:iam::123456789012:instance-profile/web";
		expect(await giveSsmAccess({}, "i-1", HOST_POLICY)).toBe(
			"Added SSM access and the host policy to the instance's role, web-role.",
		);
		expect(attached()).toEqual([
			{ RoleName: "web-role", PolicyArn: SSM_POLICY },
			{ RoleName: "web-role", PolicyArn: HOST_POLICY },
		]);
		expect(sent.map((call) => call.name)).not.toContain("CreateRoleCommand");
	});

	test("and on the OdinSsmHost role it makes for an instance with no role", async () => {
		sent.length = 0;
		instanceProfileArn = undefined;
		expect(await giveSsmAccess({}, "i-1", HOST_POLICY)).toBe(
			"Attached the OdinSsmHost role, with SSM access and the host policy, to the instance.",
		);
		expect(attached()).toEqual([
			{ RoleName: "OdinSsmHost", PolicyArn: SSM_POLICY },
			{ RoleName: "OdinSsmHost", PolicyArn: HOST_POLICY },
		]);
		expect(sent.map((call) => call.name)).toEqual([
			"DescribeInstancesCommand",
			"CreateRoleCommand",
			"AttachRolePolicyCommand",
			"AttachRolePolicyCommand",
			"CreateInstanceProfileCommand",
			"AddRoleToInstanceProfileCommand",
			"AssociateIamInstanceProfileCommand",
		]);
	});

	test("with no host policy set, SSM's alone goes on, as before", async () => {
		sent.length = 0;
		instanceProfileArn = "arn:aws:iam::123456789012:instance-profile/web";
		expect(await giveSsmAccess({}, "i-1")).toBe(
			"Added SSM access to the instance's role, web-role.",
		);
		expect(attached()).toEqual([
			{ RoleName: "web-role", PolicyArn: SSM_POLICY },
		]);
	});

	test("a host policy that is not an ARN stops before AWS is asked anything", async () => {
		sent.length = 0;
		await expect(giveSsmAccess({}, "i-1", "odin-host")).rejects.toThrow(
			"Not an IAM policy ARN",
		);
		expect(sent).toEqual([]);
	});

	test("New host offers the launch templates tagged Odin = host, by name", async () => {
		answer = (name) =>
			name === "DescribeLaunchTemplatesCommand"
				? {
						LaunchTemplates: [
							{ LaunchTemplateId: "lt-2", LaunchTemplateName: "odin-host-gpu" },
							{ LaunchTemplateId: "lt-1", LaunchTemplateName: "odin-host" },
						],
					}
				: undefined;
		expect(await listLaunchTemplates({})).toEqual([
			{ id: "lt-1", name: "odin-host" },
			{ id: "lt-2", name: "odin-host-gpu" },
		]);
		expect(sent).toEqual([
			{
				name: "DescribeLaunchTemplatesCommand",
				input: { Filters: [{ Name: "tag:Odin", Values: ["host"] }] },
			},
		]);
	});

	test("it launches the template's default version, named and with the picker's tags on the instance and its disk", async () => {
		answer = (name) =>
			name === "RunInstancesCommand"
				? { Instances: [{ InstanceId: "i-new" }] }
				: undefined;
		expect(
			await launchHost({}, "lt-1", " odin-dan ", [
				{ key: "Owner", value: "dan" },
				{ key: "Name", value: "odin-remote" },
			]),
		).toBe("i-new");
		const tags = [
			{ Key: "Name", Value: "odin-dan" },
			{ Key: "Owner", Value: "dan" },
		];
		expect(sent).toEqual([
			{
				name: "RunInstancesCommand",
				input: {
					LaunchTemplate: { LaunchTemplateId: "lt-1", Version: "$Default" },
					MinCount: 1,
					MaxCount: 1,
					TagSpecifications: [
						{ ResourceType: "instance", Tags: tags },
						{ ResourceType: "volume", Tags: tags },
					],
				},
			},
		]);
	});

	test("a name that is empty, too long or has control characters stops before AWS is asked", async () => {
		expect(hostNameProblem("odin-dan")).toBeNull();
		await expect(launchHost({}, "lt-1", "  ", [])).rejects.toThrow(
			"Give the host a name.",
		);
		await expect(launchHost({}, "lt-1", "x".repeat(65), [])).rejects.toThrow(
			"at most 64 characters",
		);
		await expect(launchHost({}, "lt-1", "odin\tdan", [])).rejects.toThrow(
			"no control characters",
		);
		expect(sent).toEqual([]);
	});

	test("waiting for the host: running first, then SSM seeing it, a look every 10 seconds", async () => {
		const states = ["pending", "running"];
		const pings = ["ConnectionLost", "Online"];
		answer = (name) => {
			if (name === "DescribeInstancesCommand")
				return {
					Reservations: [
						{
							Instances: [
								{ InstanceId: "i-new", State: { Name: states.shift() } },
							],
						},
					],
				};
			if (name === "DescribeInstanceInformationCommand")
				return {
					InstanceInformationList: [
						{ InstanceId: "i-new", PingStatus: pings.shift() },
					],
				};
			return undefined;
		};
		const slept: number[] = [];
		await waitForHost({}, "i-new", {
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		expect(sent.map((call) => call.name)).toEqual([
			"DescribeInstancesCommand",
			"DescribeInstancesCommand",
			"DescribeInstanceInformationCommand",
			"DescribeInstanceInformationCommand",
		]);
		expect(slept).toEqual([10_000, 10_000]);
	});

	test("it gives up after the limit, saying how far it got", async () => {
		answer = (name) =>
			name === "DescribeInstancesCommand"
				? {
						Reservations: [
							{
								Instances: [
									{ InstanceId: "i-new", State: { Name: "running" } },
								],
							},
						],
					}
				: { InstanceInformationList: [] };
		const sleep = async () => {};
		await expect(
			waitForHost({}, "i-new", { every: 60_000, limit: 120_000, sleep }),
		).rejects.toThrow(
			"The host is running, but SSM did not see it in 2 minutes.",
		);
		// Two looks: the instance and SSM, then SSM alone.
		expect(sent).toHaveLength(3);
		answer = () => ({
			Reservations: [
				{ Instances: [{ InstanceId: "i-new", State: { Name: "pending" } }] },
			],
		});
		await expect(
			waitForHost({}, "i-new", { every: 10_000, limit: 600_000, sleep }),
		).rejects.toThrow("The host did not start in 10 minutes; it is pending.");
	});

	test("a host that stops or terminates while waited for fails at once", async () => {
		answer = () => ({
			Reservations: [
				{ Instances: [{ InstanceId: "i-new", State: { Name: "terminated" } }] },
			],
		});
		await expect(
			waitForHost({}, "i-new", { sleep: async () => {} }),
		).rejects.toThrow("The new host is terminated.");
		expect(sent).toHaveLength(1);
	});
});
