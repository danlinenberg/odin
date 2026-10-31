import { describe, expect, test } from "bun:test";
import {
	accessDenied,
	keyInvalid,
	keyRefused,
	pluginArgs,
	pluginBuild,
	userMissing,
} from "./ssm";

describe("ssm", () => {
	test("a host that took none of the offered keys reads as a refused key", () => {
		expect(
			keyRefused(new Error("All configured authentication methods failed")),
		).toBe(true);
		expect(keyRefused(new Error("Timed out while waiting for handshake"))).toBe(
			false,
		);
	});

	test("Instance Connect calling a login key invalid reads as an invalid key", () => {
		expect(
			keyInvalid(
				new Error(
					"Invalid input parameter received for Invalid argument exception: ED25519 - SSH Public key is invalid",
				),
			),
		).toBe(true);
		expect(
			keyInvalid(
				Object.assign(new Error("bad"), { name: "InvalidArgsException" }),
			),
		).toBe(true);
		expect(keyInvalid(new Error("Timed out while waiting for handshake"))).toBe(
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

	test("a call IAM refuses reads as access denied", () => {
		expect(
			accessDenied(
				new Error(
					"User: arn:aws:sts::1:assumed-role/Dev/a@b.com is not authorized to perform: ssm:SendCommand on resource: arn:aws:ec2:us-east-1:1:instance/i-1 with an explicit deny in an identity-based policy",
				),
			),
		).toBe(true);
		expect(
			accessDenied(
				Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
			),
		).toBe(true);
		expect(
			accessDenied(new Error("All configured authentication methods failed")),
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
