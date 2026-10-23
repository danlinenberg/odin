import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { sh } from "./session";

/**
 * AWS profiles on the remote host, per person: the profiles a user picks in
 * Settings sign in on the host as that user, with their own AWS sign-in on
 * this computer - never with the instance's role, which every user of the
 * host shares. So a session's `aws --profile prod`, or a SessionStart hook
 * that reads Secrets Manager with it, gets what its user may do and no more.
 *
 * This computer resolves each profile's current credentials (its SSO
 * sign-in included) and sends them with the user's other tokens, every half
 * hour while it is awake. Odin's host service keeps them for that Linux user
 * alone, and the user's ~/.aws/config names each profile with a
 * credential_process that asks the service for them at each use.
 */

/** A profile name as ~/.aws/config and a shell can both take as it is. */
const PROFILE = /^[A-Za-z0-9_.+-]{1,64}$/;

export const isAwsProfileName = (name: string) => PROFILE.test(name);

export interface AwsProfile {
	name: string;
	region?: string;
}

/** The profiles a ~/.aws/config defines, with their region, in file order. */
export function awsConfigProfiles(text: string): AwsProfile[] {
	const profiles: AwsProfile[] = [];
	let current: AwsProfile | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			// Any section ends the last one; only [default] and [profile x] are profiles.
			const name =
				line.match(/^\[\s*profile\s+(\S+)\s*\]$/)?.[1] ??
				(/^\[\s*default\s*\]$/.test(line) ? "default" : "");
			current = isAwsProfileName(name) ? { name } : null;
			if (current) profiles.push(current);
			continue;
		}
		const region = line.match(/^region\s*=\s*([a-z0-9-]+)\s*$/);
		if (current && region) current.region = region[1];
	}
	return profiles;
}

/** This computer's AWS profiles with their region; none without an AWS config. */
export function localAwsProfiles(home = homedir()): AwsProfile[] {
	try {
		return awsConfigProfiles(
			readFileSync(
				process.env.AWS_CONFIG_FILE || join(home, ".aws", "config"),
				"utf8",
			),
		);
	} catch {
		return [];
	}
}

/** What credential_process prints: the shape the host service hands back. */
export interface AwsProcessCredentials {
	Version: 1;
	AccessKeyId: string;
	SecretAccessKey: string;
	SessionToken?: string;
	Expiration?: string;
}

/**
 * The current credentials of each profile, as credential_process prints
 * them. A profile that can't sign in now (its SSO sign-in expired) is left
 * out, so the host says so plainly instead of handing out dead keys.
 */
export async function hostAwsCredentials(
	profiles: readonly string[],
): Promise<Record<string, AwsProcessCredentials>> {
	const out: Record<string, AwsProcessCredentials> = {};
	await Promise.all(
		profiles.filter(isAwsProfileName).map(async (profile) => {
			try {
				const creds = await fromNodeProviderChain({ profile })();
				out[profile] = {
					Version: 1,
					AccessKeyId: creds.accessKeyId,
					SecretAccessKey: creds.secretAccessKey,
					...(creds.sessionToken ? { SessionToken: creds.sessionToken } : {}),
					...(creds.expiration
						? { Expiration: creds.expiration.toISOString() }
						: {}),
				};
			} catch (error) {
				console.warn(`[remote-host] AWS profile ${profile}:`, error);
			}
		}),
	);
	return out;
}

/**
 * The host's credential_process: the profile's credentials from Odin's host
 * service (GET /token, loopback, answered to this Linux user alone). When it
 * has none, the service's reason goes to stderr, which the aws CLI shows.
 */
export const AWS_CREDENTIAL_HELPER = `#!/bin/sh
# Odin's AWS credential_process on a remote host: this user's credentials for
# the profile, from their laptop's latest copy, held by Odin's host service.
# See Odin's aws-on-host.ts.
url="http://127.0.0.1:$((40000 + $(id -u) % 10000 * 2))/token?service=aws&profile=$1"
out=$(curl -s -m 10 --fail-with-body "$url") || { printf '%s\\n' "\${out:-Odin's host service is not answering.}" >&2; exit 1; }
printf '%s\\n' "$out"
`;

const BEGIN =
	"# >>> odin: profiles from Odin (Settings > Remote), rewritten on each sync";
const END = "# <<< odin";
const HELPER = '"$HOME/.odin/bin/aws-credential-odin"';

/**
 * Run as the host user: puts the helper on disk and rewrites Odin's block in
 * ~/.aws/config to name these profiles with it. A profile the user defined
 * there themselves is left as it is. No profiles: the block goes.
 */
export function awsHostConfigScript(profiles: readonly AwsProfile[]): string {
	const sections = profiles
		.filter((p) => isAwsProfileName(p.name))
		.map((p) => ({
			header: p.name === "default" ? "[default]" : `[profile ${p.name}]`,
			// Double-quoted so $HOME is the host user's: the aws CLI doesn't expand it.
			lines: [
				`"credential_process = $HOME/.odin/bin/aws-credential-odin ${p.name}"`,
				...(p.region ? [sh(`region = ${p.region}`)] : []),
			],
		}));
	return [
		'mkdir -p "$HOME/.odin/bin" "$HOME/.aws"',
		`printf %s ${sh(Buffer.from(AWS_CREDENTIAL_HELPER).toString("base64"))} | base64 -d > ${HELPER}.$$ && chmod 755 ${HELPER}.$$ && mv -f ${HELPER}.$$ ${HELPER}`,
		'c="$HOME/.aws/config"; touch "$c"',
		`awk -v b=${sh(BEGIN)} -v e=${sh(END)} '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$c" > "$c.$$"`,
		...(sections.length
			? [
					`{ printf '%s\\n' ${sh(BEGIN)}`,
					...sections.map(
						(s) =>
							`  grep -qxF ${sh(s.header)} "$c.$$" || printf '%s\\n' ${sh(s.header)} ${s.lines.join(" ")}`,
					),
					`  printf '%s\\n' ${sh(END)}; } >> "$c.$$"`,
				]
			: []),
		'mv -f "$c.$$" "$c"',
	].join("\n");
}
