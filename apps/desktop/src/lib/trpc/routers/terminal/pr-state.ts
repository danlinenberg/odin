import { execWithShellEnv } from "../workspaces/utils/shell-env";

/**
 * Odin fork: has this PR shipped? The brief lists the PRs a session opened,
 * and the next question is always which of them got merged.
 */

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED";

/** Injectable so the retry below is testable without a GitHub account. */
export type GhExec = (
	args: string[],
	env?: Record<string, string>,
) => Promise<{ stdout: string }>;

const gh: GhExec = (args, env) => execWithShellEnv("gh", args, { env });

/** `✓ Logged in to github.com account NAME (keyring)` — one per account. */
const ACCOUNT = /Logged in to \S+ account (\S+)/g;

function state(stdout: string): PullRequestState | null {
	const value = (JSON.parse(stdout) as { state?: string }).state;
	return value === "OPEN" || value === "MERGED" || value === "CLOSED"
		? value
		: null;
}

/**
 * `gh` talks to github.com as its *active* account, so a repo only a second
 * logged-in account can see 404s — a work org while the personal account is
 * active, or the reverse. The owner in the url doesn't name the account that
 * can read it (`imagenai/...` is read by `dan-linenberg-imagenai`), so on a
 * miss just try each logged-in account's token in turn. Null when none of them
 * can see it (no gh, no access, deleted repo); the panel shows no label.
 */
export async function pullRequestState(
	url: string,
	exec: GhExec = gh,
): Promise<PullRequestState | null> {
	const view = ["pr", "view", url, "--json", "state"];
	try {
		return state((await exec(view)).stdout);
	} catch {
		// Fall through to the other accounts.
	}
	let status: string;
	try {
		status = (await exec(["auth", "status"])).stdout;
	} catch {
		return null;
	}
	for (const [, account] of status.matchAll(ACCOUNT)) {
		try {
			const { stdout: token } = await exec([
				"auth",
				"token",
				"--user",
				account,
			]);
			return state((await exec(view, { GH_TOKEN: token.trim() })).stdout);
		} catch {
			// Not this account's repo either.
		}
	}
	return null;
}
