import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SENT_WIP_MESSAGE = "Odin: uncommitted work moved to the host";

/**
 * Where a shared checkout's uncommitted work goes on origin. Not a branch
 * (refs/heads): a push there starts no CI and lists no branch, and the host
 * deletes it once it has the work (sentNote), or this computer does when the
 * move fails (dropSnapshot). A later move of the same session overwrites it.
 */
export const snapshotRef = (sessionId: string) =>
	`refs/odin/moved/${sessionId.slice(0, 8)}`;

/** What a session on this computer took to origin before moving to the host. */
export interface SentWork {
	/** The branch pushed to origin; null when no code moved. */
	branch: string | null;
	/** Uncommitted changes went along as a WIP commit. */
	committed: boolean;
	/** Uncommitted changes stayed here: they could not be sent. */
	left: boolean;
	/**
	 * A shared checkout's work, copied rather than moved: one commit on top of
	 * its HEAD (so with its commits no remote has) holding what wasn't
	 * committed, pushed as this ref (snapshotRef). The checkout here stays as
	 * it was. It holds every uncommitted change in that checkout, other
	 * sessions' edits there included.
	 */
	snapshot: string | null;
}

/**
 * Pushes a session's work to origin so the host can check it out. In a
 * worktree of its own, its uncommitted work goes along as one WIP commit on
 * its branch. A shared checkout is never committed to (that would sweep up
 * other sessions' files and change the branch they all start from): its
 * branch is pushed when it has one of its own, and what isn't committed - or,
 * on the default branch, commits no remote has - is copied as a commit on
 * top of HEAD, built in a throwaway index, and pushed as `snapshotRef`.
 */
export async function pushWork(
	cwd: string,
	sessionId: string,
): Promise<SentWork> {
	const git = async (args: string[], env?: NodeJS.ProcessEnv) =>
		(
			await run("git", ["-C", cwd, ...args], {
				env: env && { ...process.env, ...env },
			})
		).stdout.trim();
	const dirty = (await git(["status", "--porcelain"]).catch(() => "")) !== "";
	const branch = await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(
		() => "",
	);
	const head = await git([
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD",
	]).catch(() => "origin/main");
	const named = !!branch && `origin/${branch}` !== head;
	const own =
		(await git(["rev-parse", "--absolute-git-dir"]).catch(() => "")) !==
		(await git([
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]).catch(() => ""));
	if (named && own) {
		if (dirty) {
			await git(["add", "-A"]);
			await git(["commit", "-q", "--no-verify", "-m", SENT_WIP_MESSAGE]);
		}
		await git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
		return { branch, committed: dirty, left: false, snapshot: null };
	}
	if (named) await git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
	const ahead =
		!named &&
		(await git(["rev-list", "-1", "HEAD", "--not", "--remotes"]).catch(
			() => "",
		)) !== "";
	if (!dirty && !ahead)
		return {
			branch: named ? branch : null,
			committed: false,
			left: false,
			snapshot: null,
		};
	const index = join(tmpdir(), `odin-send-${process.pid}-${Date.now()}.index`);
	const env = { GIT_INDEX_FILE: index };
	try {
		await git(["read-tree", "HEAD"], env);
		await git(["add", "-A"], env);
		const tree = await git(["write-tree"], env);
		const commit = await git(
			[
				"-c",
				"user.name=Odin",
				"-c",
				"user.email=odin@localhost",
				"commit-tree",
				tree,
				"-p",
				"HEAD",
				"-m",
				SENT_WIP_MESSAGE,
			],
			env,
		);
		const snapshot = snapshotRef(sessionId);
		await git(["push", "-q", "origin", `+${commit}:${snapshot}`]);
		return {
			branch: named ? branch : null,
			committed: dirty,
			left: false,
			snapshot,
		};
	} finally {
		await rm(index, { force: true });
	}
}

/** Deletes the session's copy from origin: the move failed. Never throws. */
export async function dropSnapshot(
	cwd: string,
	sessionId: string,
): Promise<void> {
	await run("git", [
		"-C",
		cwd,
		"push",
		"-q",
		"origin",
		`:${snapshotRef(sessionId)}`,
	]).catch(() => {});
}

/** What the person moving it is told: the copy may carry other sessions' edits. */
export const SHARED_COPY_WARNING =
	"Your checkout is shared, so the host got a copy of every uncommitted change in it, including other sessions' edits. Your checkout here is unchanged.";

/**
 * What the Claude resumed on the host is told first, before its host note.
 * `placeholder` is the branch the host's worktree starts on.
 */
export function sentNote(
	work: SentWork,
	from: string,
	placeholder: string,
): string {
	const here = `You were moved from my computer to the remote host, mid-conversation. Paths from ${from} do not exist here.`;
	const left = work.left
		? ` Uncommitted changes in ${from} stayed on my computer. Say so before you continue.`
		: "";
	if (work.snapshot) {
		const onto = work.branch ?? placeholder;
		const what = work.committed
			? "what was uncommitted there (and any commits no remote had)"
			: "its commits no remote had";
		return `${here} ${from} on my computer is a shared checkout, so Odin copied ${what} into one commit, "${SENT_WIP_MESSAGE}", pushed to origin as ${work.snapshot}. First run git fetch origin ${work.snapshot} && git checkout -B ${onto} FETCH_HEAD && git reset -q HEAD~1 && git push -q origin :${work.snapshot} in the folder you start in: that gives you the same files as uncommitted changes, on branch ${onto}, and deletes the copy from origin. Keep using that branch${work.branch ? " (and its PR, if it has one)" : ""}. That checkout is shared by other sessions, so the copy holds every uncommitted change in it, theirs included: read git status and git diff, and leave out of your commits any file that isn't part of this work.${left}`;
	}
	if (!work.branch) return `${here}${left}`;
	const wip = work.committed
		? ` Its last commit, "${SENT_WIP_MESSAGE}", holds what was uncommitted on my computer.`
		: "";
	return `${here} Your work is on branch ${work.branch}, pushed to origin. First run git fetch origin ${work.branch} && git checkout -B ${work.branch} origin/${work.branch} in the folder you start in, and keep using that branch (and its PR, if it has one) instead of the branch named below.${wip}${left}`;
}
