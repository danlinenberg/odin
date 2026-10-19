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
 * `aws sso login` for a profile, by default the one Claude uses; null is the
 * default profile. It opens the browser and waits until the user approves
 * there. The aws CLI is already on a Mac whose AWS sign-in is SSO - that is
 * what printed the error.
 */
export function awsSsoLogin(
	profile: string | null = awsProfile() ?? null,
): Promise<{ profile: string | null }> {
	// Sessions that hit the expired token together share one sign-in, not a tab each.
	let login = pending.get(profile);
	if (!login) {
		login = runSsoLogin(profile).finally(() => pending.delete(profile));
		pending.set(profile, login);
	}
	return login;
}

const pending = new Map<string | null, Promise<{ profile: string | null }>>();

async function runSsoLogin(
	profile: string | null,
): Promise<{ profile: string | null }> {
	await execWithShellEnv(
		"aws",
		["sso", "login", ...(profile ? ["--profile", profile] : [])],
		{ timeout: 5 * 60_000 },
	);
	return { profile };
}
