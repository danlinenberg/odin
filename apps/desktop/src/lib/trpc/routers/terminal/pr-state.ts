import { execWithShellEnv } from "../workspaces/utils/shell-env";

/**
 * Odin fork: has this PR shipped, and is its CI done? The brief lists the PRs a
 * session opened, and the next two questions are always which of them got
 * merged and whether the bots have finished arguing about the rest.
 */

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED";

export interface PullRequestStatus {
	state: PullRequestState;
	/** Checks still running, by name — "Cursor Bugbot" is the one you're waiting on. */
	pending: string[];
	/** Checks that failed, by name. */
	failed: string[];
	/** Checks that came back green. Skipped ones aren't counted either way. */
	passed: number;
}

/** Injectable so the retry below is testable without a GitHub account. */
export type GhExec = (
	args: string[],
	env?: Record<string, string>,
) => Promise<{ stdout: string }>;

const gh: GhExec = (args, env) => execWithShellEnv("gh", args, { env });

/** `✓ Logged in to github.com account NAME (keyring)` — one per account. */
const ACCOUNT = /Logged in to \S+ account (\S+)/g;

/**
 * One rollup entry. GitHub mixes two shapes here: Actions jobs (`CheckRun`,
 * still running until `status` is COMPLETED) and the older commit statuses
 * (`StatusContext`, which only ever has a `state`). Bots land as either.
 */
interface RollupEntry {
	name?: string;
	context?: string;
	status?: string;
	conclusion?: string;
	state?: string;
}

const FAILED = new Set([
	"FAILURE",
	"ERROR",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
]);

function status(stdout: string): PullRequestStatus | null {
	const pr = JSON.parse(stdout) as {
		state?: string;
		statusCheckRollup?: RollupEntry[] | null;
	};
	if (pr.state !== "OPEN" && pr.state !== "MERGED" && pr.state !== "CLOSED") {
		return null;
	}
	const out: PullRequestStatus = {
		state: pr.state,
		pending: [],
		failed: [],
		passed: 0,
	};
	for (const entry of pr.statusCheckRollup ?? []) {
		const name = entry.name ?? entry.context ?? "check";
		// A CheckRun carries `status`; a StatusContext only `state`. Anything not
		// finished is still in flight — that's the bit worth showing live.
		const done = entry.status ? entry.status === "COMPLETED" : true;
		const result = entry.conclusion ?? entry.state ?? "";
		if (!done || result === "PENDING" || result === "EXPECTED") {
			out.pending.push(name);
		} else if (FAILED.has(result)) {
			out.failed.push(name);
		} else if (result === "SUCCESS") {
			out.passed += 1;
		}
		// SKIPPED / NEUTRAL: didn't run, didn't fail. Counting them as green
		// inflates "12 checks passed" on repos that skip half their matrix.
	}
	return out;
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
): Promise<PullRequestStatus | null> {
	const view = ["pr", "view", url, "--json", "state,statusCheckRollup"];
	try {
		return status((await exec(view)).stdout);
	} catch {
		// Fall through to the other accounts.
	}
	let authStatus: string;
	try {
		authStatus = (await exec(["auth", "status"])).stdout;
	} catch {
		return null;
	}
	for (const [, account] of authStatus.matchAll(ACCOUNT)) {
		try {
			const { stdout: token } = await exec([
				"auth",
				"token",
				"--user",
				account,
			]);
			return status((await exec(view, { GH_TOKEN: token.trim() })).stdout);
		} catch {
			// Not this account's repo either.
		}
	}
	return null;
}
