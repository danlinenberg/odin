import { describe, expect, test } from "bun:test";
import {
	instanceFilters,
	parseTools,
	profileNames,
	setUpScript,
	tagChoices,
	toInstances,
} from "./aws-instances";

describe("aws-instances", () => {
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

	test("setup installs what is missing as root, and Claude and gh as the user", () => {
		const script = setUpScript("ubuntu");
		expect(script).toContain(
			"for p in tmux git curl python3; do command -v $p >/dev/null || pkg $p; done",
		);
		expect(script).toContain("sudo -iu 'ubuntu' bash -lc ");
		expect(script).toContain("https://claude.ai/install.sh");
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
});
