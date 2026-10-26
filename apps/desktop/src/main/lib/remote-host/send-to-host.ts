import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SENT_WIP_MESSAGE = "Odin: uncommitted work moved to the host";

/** What a session on this computer took to origin before moving to the host. */
export interface SentWork {
	/** The branch pushed to origin; null when no code moved. */
	branch: string | null;
	/** Uncommitted changes went along as a WIP commit. */
	committed: boolean;
	/** Uncommitted changes stayed here: the checkout is shared, not the session's own. */
	left: boolean;
}

/**
 * Pushes a session's branch to origin so the host can check it out. Its
 * uncommitted work goes along as one WIP commit, but only in a worktree of
 * its own: a commit in the shared checkout would sweep up other sessions'
 * files. A checkout on its default branch, or on no branch, pushes nothing.
 */
export async function pushWork(cwd: string): Promise<SentWork> {
	const git = async (...args: string[]) =>
		(await run("git", ["-C", cwd, ...args])).stdout.trim();
	const dirty = (await git("status", "--porcelain").catch(() => "")) !== "";
	const branch = await git("symbolic-ref", "--short", "-q", "HEAD").catch(
		() => "",
	);
	const head = await git(
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD",
	).catch(() => "origin/main");
	if (!branch || `origin/${branch}` === head)
		return { branch: null, committed: false, left: dirty };
	const own =
		(await git("rev-parse", "--absolute-git-dir")) !==
		(await git("rev-parse", "--path-format=absolute", "--git-common-dir"));
	const committed = dirty && own;
	if (committed) {
		await git("add", "-A");
		await git("commit", "-q", "--no-verify", "-m", SENT_WIP_MESSAGE);
	}
	await git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
	return { branch, committed, left: dirty && !own };
}

/** What the Claude resumed on the host is told first, before its host note. */
export function sentNote(work: SentWork, from: string): string {
	const here = `You were moved from my computer to the remote host, mid-conversation. Paths from ${from} do not exist here.`;
	const left = work.left
		? ` Uncommitted changes in ${from} stayed on my computer: that checkout is shared, so Odin did not commit them. Say so before you continue.`
		: "";
	if (!work.branch) return `${here}${left}`;
	const wip = work.committed
		? ` Its last commit, "${SENT_WIP_MESSAGE}", holds what was uncommitted on my computer.`
		: "";
	return `${here} Your work is on branch ${work.branch}, pushed to origin. First run git fetch origin ${work.branch} && git checkout -B ${work.branch} origin/${work.branch} in the folder you start in, and keep using that branch (and its PR, if it has one) instead of the branch named below.${wip}${left}`;
}
