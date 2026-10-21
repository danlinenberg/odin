import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { SFTPWrapper } from "ssh2";
import { lastCwd } from "../claude-sessions/claude-sessions";
import { homePath, sh, tmuxSession, worktreeDir } from "./session";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

export { lastCwd };

const run = promisify(execFile);
const git = (dir: string, ...args: string[]) =>
	run("git", ["-C", dir, ...args]);

/** Claude's folder name for a cwd under ~/.claude/projects. */
export const claudeProjectDir = (cwd: string) =>
	cwd.replace(/[^A-Za-z0-9]/g, "-");

/** What a session left in its git checkout on the host. */
export interface HostWork {
	/** The checkout's top folder on the host. */
	top: string;
	/** The session's folder inside it, "" for the top. */
	sub: string;
	origin: string | null;
	branch: string | null;
	/** The branch's commits that no remote has, as a git bundle. */
	bundle: Buffer | null;
	/**
	 * On the checkout's default branch (or no branch) with uncommitted changes
	 * or local commits: not the session's own work, so it stays on the host.
	 */
	left: boolean;
}

export const WIP_MESSAGE = "Odin: uncommitted work moved from the host";

/**
 * Run in the session's folder on the host: on the session's own branch,
 * commits what isn't committed and bundles the branch's commits no remote
 * has into `bundle`. Prints the checkout's top, the session's folder inside
 * it, origin, branch, the bundle path, and "left" when work stayed behind.
 *
 * The default branch (origin/HEAD, else main or master) is never the
 * session's own: a session there is in the shared checkout, where `git add
 * -A` would sweep up other sessions' files and a commit would land on the
 * branch every session starts from. Whatever is there stays there, and
 * `left` says so.
 * Prints nothing outside a git checkout.
 */
export const packScript = (cwd: string, bundle: string) =>
	`cd ${sh(cwd)} 2>/dev/null || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
sub=$(git rev-parse --show-prefix)
cd "$top"
branch=$(git symbolic-ref --short -q HEAD)
main=$(git symbolic-ref --short -q refs/remotes/origin/HEAD); main=\${main#origin/}
case "$branch" in main|master) [ -n "$main" ] || main=$branch;; esac
own=; [ -n "$branch" ] && [ "$branch" != "$main" ] && own=1
if [ -n "$own" ] && [ -n "$(git status --porcelain)" ]; then
	git add -A && git -c user.name=Odin -c user.email=odin@localhost commit -q --no-verify -m ${sh(WIP_MESSAGE)}
fi
rm -f ${sh(bundle)}
if [ -n "$own" ] && [ -n "$(git rev-list -1 HEAD --not --remotes)" ]; then
	git bundle create ${sh(bundle)} "$branch" --not --remotes >/dev/null 2>&1 || true
fi
left=; [ -z "$own" ] && [ -n "$(git status --porcelain)$(git rev-list -1 HEAD --not --remotes)" ] && left=left
printf '%s\\n' "$top" "\${sub%/}" "$(git remote get-url origin 2>/dev/null)" "$branch" "$([ -f ${sh(bundle)} ] && echo ${sh(bundle)})" "$left"`;

/** packScript's output. */
export function parsePacked(
	out: string,
): Omit<HostWork, "bundle"> & { bundlePath: string | null } {
	const [top = "", sub = "", origin, branch, bundlePath, left] =
		out.split("\n");
	return {
		top,
		sub,
		origin: origin || null,
		branch: branch || null,
		bundlePath: bundlePath || null,
		left: left === "left",
	};
}

/**
 * Moves a remote session to this computer: its code first, then Claude's
 * transcript into ~/.claude/projects for the folder it lands in, so
 * `claude --resume` finds it here. Then the session's tmux session on the host
 * ends, so the two never both answer. `placeIn` picks that folder from what
 * the session left on the host; if it throws, the host session keeps running.
 */
export async function bringSessionHome(
	host: HostLogin,
	sessionId: string,
	placeIn: (work: HostWork | null) => Promise<string>,
): Promise<{ cwd: string; work: HostWork | null }> {
	const client = await connectHost(host);
	try {
		const remote = await runOnHost(
			client,
			`ls "$HOME"/.claude/projects/*/${sh(`${sessionId}.jsonl`)} 2>/dev/null | head -1`,
		);
		if (!remote)
			throw new Error("The host has no conversation for this session.");
		const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
			client.sftp((err, s) => (err ? reject(err) : resolve(s))),
		);
		const read = (path: string) =>
			new Promise<Buffer>((resolve, reject) =>
				sftp.readFile(path, (err, buf) => (err ? reject(err) : resolve(buf))),
			);
		const data = await read(remote);
		const hostCwd = lastCwd(data.toString("utf8"));
		let work: HostWork | null = null;
		if (hostCwd) {
			const out = await runOnHost(
				client,
				packScript(hostCwd, `/tmp/odin-bring-home-${sessionId}.bundle`),
			);
			if (out) {
				const { bundlePath, ...packed } = parsePacked(out);
				const bundle = bundlePath ? await read(bundlePath) : null;
				work = { ...packed, bundle };
			}
		}
		const cwd = await placeIn(work);
		const dir = join(homedir(), ".claude", "projects", claudeProjectDir(cwd));
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${sessionId}.jsonl`), data);
		await runOnHost(client, killTmux(sessionId));
		return { cwd, work };
	} finally {
		client.end();
	}
}

/**
 * The session's transcript mirror here (a remote terminal keeps one in
 * ~/.claude/projects), copied to the folder `placeIn` picks, for a host that
 * can't be reached. Null without a mirror. The code and the tmux session stay
 * on the host.
 */
export async function bringMirrorHome(
	sessionId: string,
	placeIn: (work: HostWork | null) => Promise<string>,
	projects = join(homedir(), ".claude", "projects"),
): Promise<string | null> {
	const file = `${sessionId}.jsonl`;
	const dirs = await readdir(projects).catch(() => []);
	const mirror = dirs
		.map((dir) => join(projects, dir, file))
		.find((path) => existsSync(path));
	if (!mirror) return null;
	const cwd = await placeIn(null);
	const dir = join(projects, claudeProjectDir(cwd));
	await mkdir(dir, { recursive: true });
	if (join(dir, file) !== mirror) await copyFile(mirror, join(dir, file));
	return cwd;
}

/** `path`, or `path-2`, `path-3`... whichever `taken` says is free. */
async function free(
	path: string,
	taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? path : `${path}-${n}`;
		if (!(await taken(candidate))) return candidate;
	}
}

/**
 * The host's branch in a worktree of the local checkout `repo`, under the
 * same name when it's free: its commits from the bundle, and the work that
 * wasn't committed back as uncommitted changes. Returns the worktree and
 * the branch.
 */
export async function unpackWork(
	repo: string,
	work: HostWork & { bundle: Buffer; branch: string },
): Promise<{ dir: string; branch: string }> {
	const file = join(tmpdir(), `odin-bring-home-${Date.now()}.bundle`);
	await writeFile(file, work.bundle);
	try {
		// The bundle's base is on the remote; fetch it so the bundle applies.
		await git(repo, "fetch", "--quiet", "origin").catch(() => {});
		const branch = await free(work.branch, (name) =>
			git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`).then(
				() => true,
				() => false,
			),
		);
		const dir = await free(
			join(repo, ".worktrees", basename(work.top)),
			async (path) => existsSync(path),
		);
		await git(repo, "fetch", "--quiet", file, `${work.branch}:${branch}`);
		await git(repo, "worktree", "add", "--quiet", dir, branch);
		// The host commits uncommitted work to move it; undo that commit here.
		const { stdout } = await git(dir, "log", "-1", "--format=%s");
		if (stdout.trim() === WIP_MESSAGE) {
			await git(dir, "reset", "--quiet", "--soft", "HEAD~1");
			await git(dir, "reset", "--quiet");
		}
		return { dir, branch };
	} finally {
		await rm(file, { force: true });
	}
}

/** What the resumed Claude is told first: it moved, and where its work is. */
export function movedNote(
	cwd: string,
	work: HostWork | null,
	branch: string | null,
): string {
	const here = `You were moved from the remote host to this computer. You now run in ${cwd}`;
	if (branch)
		return `${here}, on branch ${branch}. Your commits and uncommitted work from the host are here. Continue the task.`;
	if (work?.bundle)
		return `${here}. Your work is NOT here: it stays on the host in ${work.top}, branch ${work.branch}, because this computer has no checkout of ${work.origin ?? "that repo"}. Say so before you continue.`;
	if (work?.left)
		return `${here}. Nothing moved from the host: that checkout, ${work.top}, was ${work.branch ? `on its default branch ${work.branch}` : "not on a branch"}, so its uncommitted changes and local commits stay there. Say so before you continue.`;
	return `${here}. Paths from the host do not exist here. Continue the task.`;
}

/** movedNote for a session moved from its mirror: the host was unreachable. */
export const unreachableNote = (cwd: string) =>
	`You were moved from the remote host to this computer, which could not reach the host. You now run in ${cwd}. Your code and uncommitted work stay on the host, and paths from it do not exist here. Say so before you continue.`;

const killTmux = (sessionId: string) =>
	`tmux kill-session -t ${sh(tmuxSession(sessionId))} 2>/dev/null; true`;

/**
 * Run on the host after a session's Done: its worktree goes, as Storage's
 * forced delete does here - each one is a full install, and the host has no
 * pruner. It is <reposRoot>/<repo>/.worktrees/odin-<id>, or under ~/repos
 * for a task that cloned its own repo (hostNote). The branch stays, so a
 * Resume gets the worktree back from it (runScript); files not committed go
 * to refs/pruned/<name> first, and `git checkout refs/pruned/<name> -- .`
 * brings them back. A worktree whose files can't be saved is kept. The
 * folder is moved aside and deleted in the background: git forgets it at
 * once, and the call doesn't wait on a 3 GB install. Prints "removed <path>"
 * or "kept <path> (why)" per worktree; nothing when there is none.
 */
export function removeWorktreeScript(
	sessionId: string,
	reposRoot: string,
): string {
	const name = worktreeDir(sessionId);
	return `for wt in ${homePath(reposRoot)}/*/.worktrees/${sh(name)} "$HOME"/repos/*/.worktrees/${sh(name)}; do
	[ -e "$wt/.git" ] || continue
	repo=$(dirname "$(dirname "$wt")")
	if [ -n "$(git -C "$wt" status --porcelain)" ]; then
		# A throwaway index: gitignored output (node_modules) stays out, as in a commit.
		index=$(mktemp)
		snapshot=$(GIT_INDEX_FILE="$index" git -C "$wt" read-tree HEAD && GIT_INDEX_FILE="$index" git -C "$wt" add -A && git -C "$wt" -c user.name=Odin -c user.email=odin@localhost commit-tree "$(GIT_INDEX_FILE="$index" git -C "$wt" write-tree)" -p HEAD -m ${sh(`pruned worktree ${name}`)})
		rm -f "$index"
		[ -n "$snapshot" ] && git -C "$repo" update-ref ${sh(`refs/pruned/${name}`)} "$snapshot" || { echo "kept $wt (its uncommitted files could not be saved)"; continue; }
	fi
	trash="$repo/.git/odin-trash-${name}-$$"
	mv "$wt" "$trash" || { echo "kept $wt (could not move it aside)"; continue; }
	git -C "$repo" worktree prune
	nohup rm -rf "$trash" >/dev/null 2>&1 </dev/null &
	echo "removed $wt"
done`;
}

/**
 * Ends a remote session on the host: its tmux session (Claude there stops),
 * then its worktree, as removeWorktreeScript says. Returns that script's lines.
 */
export async function endHostSession(
	host: HostLogin,
	sessionId: string,
	reposRoot: string,
): Promise<string[]> {
	const client = await connectHost(host);
	try {
		await runOnHost(client, killTmux(sessionId));
		const out = await runOnHost(
			client,
			removeWorktreeScript(sessionId, reposRoot),
		);
		return out.split("\n").filter(Boolean);
	} finally {
		client.end();
	}
}
