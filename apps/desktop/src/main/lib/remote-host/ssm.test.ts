import { describe, expect, test } from "bun:test";
import { keyRefused, pluginArgs, pluginBuild, userMissing } from "./ssm";

describe("ssm", () => {
	test("a host that took none of the offered keys reads as a refused key", () => {
		expect(
			keyRefused(new Error("All configured authentication methods failed")),
		).toBe(true);
		expect(keyRefused(new Error("Timed out while waiting for handshake"))).toBe(
			false,
		);
	});

	test("a host without the login's Linux user reads as a missing user", () => {
		expect(
			userMissing(
				new Error(
					"The login key did not reach i-1 (Failed): id: 'odin-dan': no such user\ninstall: invalid user 'odin-dan'",
				),
			),
		).toBe(true);
		expect(
			userMissing(new Error("Timed out while waiting for handshake")),
		).toBe(false);
	});

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
