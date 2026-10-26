import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { shell } from "electron";
import { awsClientConfig } from "main/lib/remote-host/ssm";

/** Claude Code on Bedrock names its AWS profile in its settings' env, or the shell does. */
export function awsProfile(
	home = homedir(),
	shellProfile = process.env.AWS_PROFILE,
): string | undefined {
	try {
		const settings = JSON.parse(
			readFileSync(join(home, ".claude", "settings.json"), "utf8"),
		) as { env?: { AWS_PROFILE?: string } };
		if (settings.env?.AWS_PROFILE) return settings.env.AWS_PROFILE;
	} catch {}
	return shellProfile || undefined;
}

type SsoLogin = {
	/** The approval page, for a pane to show in case no tab came up. */
	link: Promise<string>;
	done: Promise<{ profile: string | null }>;
};

/**
 * AWS SSO sign-in for a profile, by default the one Claude uses; null is the
 * default profile. Odin runs the device flow itself and opens the approval
 * page, so it needs no aws CLI.
 */
export function awsSsoLogin(
	profile: string | null = awsProfile() ?? null,
): SsoLogin {
	// Sessions that hit the expired token together share one sign-in, not a tab each.
	let login = pending.get(profile);
	if (!login) {
		login = runSsoLogin(profile);
		login.done.finally(() => pending.delete(profile)).catch(() => {});
		pending.set(profile, login);
	}
	return login;
}

const pending = new Map<string | null, SsoLogin>();

/**
 * Opens the approval page again for a sign-in already waiting on it - the tab
 * Odin opened was closed, or never came up - or starts a new sign-in, which
 * opens its own. Nothing opens when the profile turns out to be signed in.
 */
export async function reopenAwsSignIn(profile: string | null): Promise<void> {
	const waiting = pending.get(profile);
	const { link, done } = awsSsoLogin(profile);
	if (!waiting) return;
	const url = await Promise.race([
		link,
		done.then(
			() => null,
			() => null,
		),
	]);
	if (url) await shell.openExternal(url);
}

/** A profile's SSO settings in ~/.aws/config, in either layout the SDK reads. */
export interface SsoConfig {
	startUrl: string;
	region: string;
	/** The [sso-session] name: its token refreshes, and is filed under it. */
	session?: string;
	scopes?: string[];
}

/** The sections of an AWS config file, keyed by header ("profile dev", "default", "sso-session x"). */
export function parseIni(text: string): Record<string, Record<string, string>> {
	const sections: Record<string, Record<string, string>> = {};
	let current: Record<string, string> | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/^\s*[#;].*$/, "").trim();
		const header = line.match(/^\[\s*(.+?)\s*\]$/);
		if (header) {
			current = sections[header[1].replace(/\s+/g, " ")] ??= {};
		} else if (current && line.includes("=")) {
			const at = line.indexOf("=");
			current[line.slice(0, at).trim()] = line.slice(at + 1).trim();
		}
	}
	return sections;
}

export function ssoConfig(
	configText: string,
	profile: string | null,
): SsoConfig | null {
	const sections = parseIni(configText);
	const name = profile ?? "default";
	const p =
		sections[name === "default" ? "default" : `profile ${name}`] ??
		sections[name];
	if (!p) return null;
	if (p.sso_session) {
		const s = sections[`sso-session ${p.sso_session}`];
		if (!s?.sso_start_url || !s.sso_region) return null;
		return {
			startUrl: s.sso_start_url,
			region: s.sso_region,
			session: p.sso_session,
			scopes: (s.sso_registration_scopes ?? "sso:account:access")
				.split(",")
				.map((x) => x.trim())
				.filter(Boolean),
		};
	}
	if (!p.sso_start_url || !p.sso_region) return null;
	return { startUrl: p.sso_start_url, region: p.sso_region };
}

/** Where the SDK looks for the token: named by the session, or the start URL in the older layout. */
export const ssoCacheFile = (sso: SsoConfig, home = homedir()): string =>
	join(
		home,
		".aws",
		"sso",
		"cache",
		`${createHash("sha1")
			.update(sso.session ?? sso.startUrl)
			.digest("hex")}.json`,
	);

/** One call to AWS's SSO OIDC service: unsigned JSON, so no aws CLI and no extra SDK client. */
async function oidc<T>(region: string, path: string, body: object): Promise<T> {
	const res = await fetch(`https://oidc.${region}.amazonaws.com${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = (await res.json().catch(() => ({}))) as T & {
		error?: string;
		error_description?: string;
	};
	if (!res.ok)
		throw Object.assign(
			new Error(
				json.error_description ||
					json.error ||
					`AWS sign-in ${path}: ${res.status}`,
			),
			{ code: json.error },
		);
	return json;
}

/**
 * AWS's device sign-in, what `aws sso login` does, inside Odin: register,
 * open the approval page with the code filled in, wait for the approval, and
 * file the token where the SDK reads it. Nothing to install on Windows, where
 * no aws CLI comes with the machine.
 */
export async function deviceSignIn(
	sso: SsoConfig,
	onLink: (url: string) => void,
	{
		home = homedir(),
		sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
		now = Date.now,
	} = {},
): Promise<void> {
	const client = await oidc<{
		clientId: string;
		clientSecret: string;
		clientSecretExpiresAt: number;
	}>(sso.region, "/client/register", {
		clientName: "odin",
		clientType: "public",
		...(sso.scopes && { scopes: sso.scopes }),
	});
	const device = await oidc<{
		deviceCode: string;
		verificationUriComplete: string;
		expiresIn: number;
		interval?: number;
	}>(sso.region, "/device_authorization", {
		clientId: client.clientId,
		clientSecret: client.clientSecret,
		startUrl: sso.startUrl,
	});
	onLink(device.verificationUriComplete);
	let interval = (device.interval ?? 5) * 1000;
	const deadline = now() + device.expiresIn * 1000;
	while (now() < deadline) {
		await sleep(interval);
		try {
			const token = await oidc<{
				accessToken: string;
				expiresIn: number;
				refreshToken?: string;
			}>(sso.region, "/token", {
				clientId: client.clientId,
				clientSecret: client.clientSecret,
				grantType: "urn:ietf:params:oauth:grant-type:device_code",
				deviceCode: device.deviceCode,
			});
			const file = ssoCacheFile(sso, home);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(
				file,
				JSON.stringify({
					startUrl: sso.startUrl,
					region: sso.region,
					accessToken: token.accessToken,
					expiresAt: new Date(now() + token.expiresIn * 1000).toISOString(),
					...(sso.session && {
						clientId: client.clientId,
						clientSecret: client.clientSecret,
						registrationExpiresAt: new Date(
							client.clientSecretExpiresAt * 1000,
						).toISOString(),
						refreshToken: token.refreshToken,
					}),
				}),
				{ mode: 0o600 },
			);
			return;
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === "slow_down") interval += 5000;
			else if (code !== "authorization_pending") throw error;
		}
	}
	throw new Error("The AWS sign-in was not approved in time.");
}

function runSsoLogin(profile: string | null): SsoLogin {
	let gotLink: (link: string) => void = () => {};
	const link = new Promise<string>((resolve) => {
		gotLink = resolve;
	});
	// Signed in already (a terminal, another pane): nothing to approve.
	const signedIn = awsClientConfig({ profile })
		.credentials()
		.then(
			() => true,
			() => false,
		);
	const done = signedIn.then(async (ready) => {
		if (ready) return { profile };
		const configFile =
			process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
		const sso = ssoConfig(
			await readFile(configFile, "utf8").catch(() => ""),
			profile,
		);
		if (!sso)
			throw new Error(
				`The AWS profile ${profile ?? "default"} has no SSO sign-in in ${configFile}.`,
			);
		await deviceSignIn(sso, (url) => {
			gotLink(url);
			shell.openExternal(url).catch(() => {});
		});
		return { profile };
	});
	return { link, done };
}
