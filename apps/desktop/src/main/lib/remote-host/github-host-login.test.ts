import { describe, expect, test } from "bun:test";
import { pollHostGithubLogin, startHostGithubLogin } from "./github-host-login";

/** A GitHub that answers each URL as told, and remembers what it was asked. */
function fakeGithub(answers: Record<string, unknown>) {
	const calls: { url: string; body: string; auth: string | null }[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({
			url: String(url),
			body: String(init?.body ?? ""),
			auth: headers.get("Authorization"),
		});
		return new Response(JSON.stringify(answers[String(url)] ?? {}));
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}

describe("the host's own GitHub sign-in", () => {
	test("starts the device flow with the app's client id and the repo scope", async () => {
		const github = fakeGithub({
			"https://github.com/login/device/code": {
				device_code: "dev-1",
				user_code: "ABCD-1234",
				verification_uri: "https://github.com/login/device",
				interval: 5,
				expires_in: 899,
			},
		});
		expect(await startHostGithubLogin("Ov23host", github.fetchFn)).toEqual({
			deviceCode: "dev-1",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			intervalSeconds: 5,
			expiresInSeconds: 899,
		});
		expect(github.calls[0].body).toBe(
			"client_id=Ov23host&scope=repo+read%3Aorg",
		);
	});

	test("says why GitHub wouldn't start it", async () => {
		const github = fakeGithub({
			"https://github.com/login/device/code": {
				error: "device_flow_disabled",
				error_description: "Device Flow must be explicitly enabled",
			},
		});
		expect(startHostGithubLogin("Ov23host", github.fetchFn)).rejects.toThrow(
			"Device Flow must be explicitly enabled",
		);
	});

	test("polls until approved, honouring slow_down, then names the account and keeps the whole pair", async () => {
		const pending = fakeGithub({
			"https://github.com/login/oauth/access_token": {
				error: "slow_down",
				interval: 10,
			},
		});
		expect(
			await pollHostGithubLogin("Ov23host", "dev-1", pending.fetchFn),
		).toEqual({
			state: "pending",
			intervalSeconds: 10,
		});
		expect(pending.calls[0].body).toBe(
			"client_id=Ov23host&device_code=dev-1&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
		);
		const approved = fakeGithub({
			"https://github.com/login/oauth/access_token": {
				access_token: "gho_host",
				refresh_token: "ghr_host",
				expires_in: 28_800,
			},
			"https://api.github.com/user": { login: "dan-work" },
		});
		expect(
			await pollHostGithubLogin(
				"Ov23host",
				"dev-1",
				approved.fetchFn,
				() => 1_700_000_000_000,
			),
		).toEqual({
			state: "signed-in",
			login: "dan-work",
			pair: {
				access_token: "gho_host",
				refresh_token: "ghr_host",
				expires_at: 1_700_000_000 + 28_800,
				client_id: "Ov23host",
			},
		});
		expect(approved.calls[1].auth).toBe("Bearer gho_host");
	});

	test("an app without expiring tokens gives a pair with no expiry, kept as it is", async () => {
		const github = fakeGithub({
			"https://github.com/login/oauth/access_token": {
				access_token: "gho_forever",
			},
			"https://api.github.com/user": { login: "dan-work" },
		});
		const result = await pollHostGithubLogin(
			"Ov23host",
			"dev-1",
			github.fetchFn,
		);
		expect(result).toEqual({
			state: "signed-in",
			login: "dan-work",
			pair: { access_token: "gho_forever", client_id: "Ov23host" },
		});
	});

	test("a refused or expired code is an error, not a wait", async () => {
		const github = fakeGithub({
			"https://github.com/login/oauth/access_token": {
				error: "expired_token",
				error_description: "The device code has expired",
			},
		});
		expect(
			pollHostGithubLogin("Ov23host", "dev-1", github.fetchFn),
		).rejects.toThrow("The device code has expired");
	});
});
