import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execWithShellEnv } from "../workspaces/utils/shell-env";

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

/**
 * `aws sso login` for the profile Claude uses. It opens the browser and waits
 * until the user approves there. The aws CLI is already on a Mac whose Claude
 * runs on Bedrock SSO - that is what printed the error.
 */
export async function awsSsoLogin(): Promise<{ profile: string | null }> {
	const profile = awsProfile();
	await execWithShellEnv(
		"aws",
		["sso", "login", ...(profile ? ["--profile", profile] : [])],
		{ timeout: 5 * 60_000 },
	);
	return { profile: profile ?? null };
}
