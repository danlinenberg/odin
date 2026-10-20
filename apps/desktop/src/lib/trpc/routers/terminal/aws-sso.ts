import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shell } from "electron";
import { getProcessEnvWithShellEnv } from "../workspaces/utils/shell-env";

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
 * `aws sso login` for a profile, by default the one Claude uses; null is the
 * default profile. Odin opens the approval page itself: the aws CLI drops a
 * failed browser open without a word, and the sign-in then waits on a tab
 * that never came. The aws CLI is already on a Mac whose AWS sign-in is SSO -
 * that is what printed the error.
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

/** The last URL the CLI printed: in the device flow, the one with the code filled in. */
export const approvalLink = (output: string): string | null =>
	output.match(/https:\/\/\S+/g)?.at(-1) ?? null;

function runSsoLogin(profile: string | null): SsoLogin {
	let gotLink: (link: string) => void = () => {};
	const link = new Promise<string>((resolve) => {
		gotLink = resolve;
	});
	const done = getProcessEnvWithShellEnv().then(
		(env) =>
			new Promise<{ profile: string | null }>((resolve, reject) => {
				const child = spawn(
					"aws",
					[
						"sso",
						"login",
						"--no-browser",
						...(profile ? ["--profile", profile] : []),
					],
					{ env, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000 },
				);
				let output = "";
				let settle: ReturnType<typeof setTimeout> | undefined;
				// The device flow prints the bare URL first and the code-filled one
				// a moment later, so the link is read once the output goes quiet.
				let opened = false;
				const read = (chunk: Buffer) => {
					output += chunk;
					clearTimeout(settle);
					settle = setTimeout(() => {
						const url = approvalLink(output);
						if (!url || opened) return;
						opened = true;
						gotLink(url);
						shell.openExternal(url).catch(() => {});
					}, 500);
				};
				child.stdout.on("data", read);
				child.stderr.on("data", read);
				child.on("error", reject);
				child.on("close", (code) => {
					clearTimeout(settle);
					if (code === 0) resolve({ profile });
					else
						reject(new Error(output.trim() || `aws sso login exited ${code}`));
				});
			}),
	);
	return { link, done };
}
