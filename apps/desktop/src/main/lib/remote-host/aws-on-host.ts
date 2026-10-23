import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sh } from "./session";

/**
 * AWS profiles on the remote host: the names the user picks in Settings are
 * defined in the host's ~/.aws/config with no keys of their own, so the aws
 * CLI and SDKs sign them in with the instance's role, the last link of
 * their credential chain (the role Odin attaches the host policy to,
 * aws-instances). So a session's `aws --profile prod`, or a SessionStart
 * hook that reads Secrets Manager with it, works there with what that role
 * may do. No credentials of this computer's go to the host.
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

const BEGIN =
	"# >>> odin: profiles from Odin (Settings > Remote), rewritten on each sync";
const END = "# <<< odin";

/**
 * Run as the host user: rewrites Odin's block in ~/.aws/config to define
 * these profiles, keyless, so they sign in with the instance's role. A
 * profile the user defined there themselves is left as it is. No profiles:
 * the block goes.
 */
export function awsHostConfigScript(profiles: readonly AwsProfile[]): string {
	const sections = profiles
		.filter((p) => isAwsProfileName(p.name))
		.map((p) => ({
			header: p.name === "default" ? "[default]" : `[profile ${p.name}]`,
			lines: p.region ? [`region = ${p.region}`] : [],
		}));
	return [
		'mkdir -p "$HOME/.aws"; c="$HOME/.aws/config"; touch "$c"',
		`awk -v b=${sh(BEGIN)} -v e=${sh(END)} '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$c" > "$c.$$"`,
		...(sections.length
			? [
					`{ printf '%s\\n' ${sh(BEGIN)}`,
					...sections.map(
						(s) =>
							`  grep -qxF ${sh(s.header)} "$c.$$" || printf '%s\\n' ${[s.header, ...s.lines].map(sh).join(" ")}`,
					),
					`  printf '%s\\n' ${sh(END)}; } >> "$c.$$"`,
				]
			: []),
		'mv -f "$c.$$" "$c"',
	].join("\n");
}
