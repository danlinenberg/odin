import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Which AWS profile Odin signs in with when none is picked in Settings.
 * AWS's own choice is AWS_PROFILE, else [default]; many configs (SSO ones
 * most of all) have only named profiles, and there AWS's choice is a
 * profile that doesn't exist. Odin then uses the config's first profile.
 */

const readAwsFile = (
	file: string | undefined,
	fallback: string,
	home: string,
): string => {
	try {
		return fs.readFileSync(file || path.join(home, ".aws", fallback), "utf8");
	} catch {
		return "";
	}
};

/** Profile names in the AWS config and credentials files - section names, nothing more. */
export function profileNames(config: string, credentials: string): string[] {
	const names = new Set<string>();
	for (const [text, prefixed] of [
		[config, true],
		[credentials, false],
	] as const)
		for (const match of text.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)) {
			const section = (match[1] ?? "").trim();
			if (section === "default") names.add("default");
			else if (!prefixed) names.add(section);
			else if (section.startsWith("profile "))
				names.add(section.slice(8).trim());
		}
	return [...names].sort();
}

export function listAwsProfiles(home = os.homedir()): string[] {
	return profileNames(
		readAwsFile(process.env.AWS_CONFIG_FILE, "config", home),
		readAwsFile(process.env.AWS_SHARED_CREDENTIALS_FILE, "credentials", home),
	);
}

/**
 * The profile to use when none is picked: undefined when AWS's own choice
 * works (AWS_PROFILE or AWS_ACCESS_KEY_ID is set, there is a [default], or
 * there are no profiles at all), else the first named profile. Naming a
 * profile makes the SDK skip keys in the environment, so those keep it off.
 */
export function fallbackAwsProfile(
	profiles: string[] = listAwsProfiles(),
	vars: Record<string, string | undefined> = process.env,
): string | undefined {
	if (
		vars.AWS_PROFILE ||
		vars.AWS_ACCESS_KEY_ID ||
		!profiles.length ||
		profiles.includes("default")
	)
		return undefined;
	return profiles[0];
}

/** The profile a picked one (or none) signs in with. */
export const awsProfileFor = (picked?: string | null): string | undefined =>
	picked || fallbackAwsProfile();

/** A setting from a profile's section in the AWS config, if set. */
export function profileSetting(
	config: string,
	profile: string,
	key: string,
): string | undefined {
	const header = profile === "default" ? "default" : `profile ${profile}`;
	let inside = false;
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		const section = line.match(/^\[\s*(.+?)\s*\]$/);
		if (section) {
			inside = section[1].replace(/\s+/g, " ") === header;
			continue;
		}
		const value = inside && line.match(/^([\w-]+)\s*=\s*(\S+)$/);
		if (value && value[1] === key) return value[2];
	}
	return undefined;
}

/** The region a profile's section in the AWS config sets, if any. */
export const profileRegion = (config: string, profile: string) =>
	profileSetting(config, profile, "region");

export const localAwsConfig = (home = os.homedir()) =>
	readAwsFile(process.env.AWS_CONFIG_FILE, "config", home);

export const localProfileRegion = (
	profile: string,
	home = os.homedir(),
): string | undefined => profileRegion(localAwsConfig(home), profile);
