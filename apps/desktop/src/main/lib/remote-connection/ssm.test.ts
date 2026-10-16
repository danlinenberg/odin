import { describe, expect, test } from "bun:test";
import { pluginArgs, pluginBuild } from "./ssm";

describe("ssm", () => {
	test("the plugin gets the session, region, profile and request the aws CLI gives it", () => {
		const request = {
			Target: "i-1",
			DocumentName: "AWS-StartSSHSession",
			Parameters: { portNumber: ["22"] },
		};
		expect(
			pluginArgs(
				{ SessionId: "s", TokenValue: "t", StreamUrl: "u" },
				request,
				"us-east-1",
				"dev",
			),
		).toEqual([
			'{"SessionId":"s","TokenValue":"t","StreamUrl":"u"}',
			"us-east-1",
			"StartSession",
			"dev",
			JSON.stringify(request),
			"https://ssm.us-east-1.amazonaws.com",
		]);
	});

	test("a pinned build per supported platform, and a plain refusal elsewhere", () => {
		expect(pluginBuild("darwin", "arm64").sha256).toHaveLength(64);
		expect(pluginBuild("win32", "x64").binary.at(-1)).toBe(
			"session-manager-plugin.exe",
		);
		expect(() => pluginBuild("linux", "arm64")).toThrow(
			"not available on linux arm64",
		);
	});
});
