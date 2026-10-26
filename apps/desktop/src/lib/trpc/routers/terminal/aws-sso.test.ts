import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsProfile, deviceSignIn, ssoCacheFile, ssoConfig } from "./aws-sso";

test("awsProfile prefers Claude's settings env, then the shell's", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-aws-"));
	expect(awsProfile(home, undefined)).toBeUndefined();
	expect(awsProfile(home, "shell")).toBe("shell");
	mkdirSync(join(home, ".claude"));
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({ env: { AWS_PROFILE: "bedrock" } }),
	);
	expect(awsProfile(home, "shell")).toBe("bedrock");
});

const CONFIG = `[default]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1

[profile dev]
# a comment
sso_session = corp
region = eu-west-1

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = eu-west-1
`;

test("ssoConfig reads the per-profile layout and the sso-session one", () => {
	expect(ssoConfig(CONFIG, null)).toEqual({
		startUrl: "https://example.awsapps.com/start",
		region: "us-east-1",
	});
	expect(ssoConfig(CONFIG, "dev")).toEqual({
		startUrl: "https://corp.awsapps.com/start",
		region: "eu-west-1",
		session: "corp",
		scopes: ["sso:account:access"],
	});
	expect(ssoConfig(CONFIG, "missing")).toBeNull();
});

test("ssoCacheFile names the token the way the SDK looks it up", () => {
	expect(
		ssoCacheFile(
			{ startUrl: "https://example.awsapps.com/start", region: "x" },
			"/h",
		),
	).toBe(
		join(
			"/h",
			".aws",
			"sso",
			"cache",
			`${createHash("sha1").update("https://example.awsapps.com/start").digest("hex")}.json`,
		),
	);
	expect(
		ssoCacheFile({ startUrl: "u", region: "x", session: "corp" }, "/h"),
	).toEndWith(`${createHash("sha1").update("corp").digest("hex")}.json`);
});

test("deviceSignIn opens the approval link, waits out pending, and files the token", async () => {
	const home = mkdtempSync(join(tmpdir(), "odin-aws-"));
	const calls: string[] = [];
	let polls = 0;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		const path = new URL(url).pathname;
		calls.push(path);
		const reply = (status: number, body: object) =>
			new Response(JSON.stringify(body), { status });
		if (path === "/client/register")
			return reply(200, {
				clientId: "id",
				clientSecret: "secret",
				clientSecretExpiresAt: 2_000_000_000,
			});
		if (path === "/device_authorization")
			return reply(200, {
				deviceCode: "dc",
				verificationUriComplete: "https://device/?user_code=AB",
				expiresIn: 600,
				interval: 1,
			});
		return ++polls < 2
			? reply(400, { error: "authorization_pending" })
			: reply(200, { accessToken: "tok", expiresIn: 3600, refreshToken: "r" });
	}) as typeof fetch;
	try {
		const links: string[] = [];
		const sso = {
			startUrl: "u",
			region: "us-east-1",
			session: "corp",
			scopes: ["sso:account:access"],
		};
		await deviceSignIn(sso, (l) => links.push(l), {
			home,
			sleep: async () => {},
			now: () => 0,
		});
		expect(links).toEqual(["https://device/?user_code=AB"]);
		expect(calls).toEqual([
			"/client/register",
			"/device_authorization",
			"/token",
			"/token",
		]);
		const cached = JSON.parse(readFileSync(ssoCacheFile(sso, home), "utf8"));
		expect(cached).toMatchObject({
			accessToken: "tok",
			refreshToken: "r",
			clientId: "id",
			startUrl: "u",
		});
		expect(cached.expiresAt).toBe(new Date(3_600_000).toISOString());
	} finally {
		globalThis.fetch = realFetch;
	}
});
