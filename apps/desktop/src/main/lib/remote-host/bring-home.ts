import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { SFTPWrapper } from "ssh2";
import { sh, tmuxSession } from "./session";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

const run = promisify(execFile);
const git = (dir: string, ...args: string[]) =>
	run("git", ["-C", dir, ...args]);

/** Claude's folder name for a cwd under ~/.claude/projects. */
export const claudeProjectDir = (cwd: string) =>
	cwd.replace(/[^A-Za-z0-9]/g, "-");

/** The folder a transcript's last turn ran in. */
export function lastCwd(transcript: string): string | null {
	const lines = transcript.trimEnd().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const cwd = JSON.parse(lines[i] ?? "")?.cwd;
			if (typeof cwd === "string" && cwd) return cwd;
		} catch {}
	}
	return null;
}

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
}

export const WIP_MESSAGE = "Odin: uncommitted work moved from the host";

/**
 * Run in the session's folder on the host: commits what isn't committed,
 * bundles the branch's commits no remote has into `bundle`, and prints the
 * checkout's top, the session's folder inside it, origin, branch and the
 * bundle path.
 * Prints nothing outside a git checkout.
 */
export const packScript = (cwd: string, bundle: string) =>
	`cd ${sh(cwd)} 2>/dev/null || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
sub=$(git rev-parse --show-prefix)
cd "$top"
branch=$(git symbolic-ref --short -q HEAD)
if [ -n "$branch" ] && [ -n "$(git status --porcelain)" ]; then
	git add -A && git -c user.name=Odin -c user.email=odin@localhost commit -q --no-verify -m ${sh(WIP_MESSAGE)}
fi
rm -f ${sh(bundle)}
if [ -n "$branch" ] && [ -n "$(git rev-list -1 HEAD --not --remotes)" ]; then
	git bundle create ${sh(bundle)} "$branch" --not --remotes >/dev/null 2>&1 || true
fi
printf '%s\\n' "$top" "\${sub%/}" "$(git remote get-url origin 2>/dev/null)" "$branch" "$([ -f ${sh(bundle)} ] && echo ${sh(bundle)})"`;

/** packScript's output. */
export function parsePacked(
	out: string,
): Omit<HostWork, "bundle"> & { bundlePath: string | null } {
	const [top = "", sub = "", origin, branch, bundlePath] = out.split("\n");
	return {
		top,
		sub,
		origin: origin || null,
		branch: branch || null,
		bundlePath: bundlePath || null,
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
	return `${here}. Paths from the host do not exist here. Continue the task.`;
}

/** movedNote for a session moved from its mirror: the host was unreachable. */
export const unreachableNote = (cwd: string) =>
	`You were moved from the remote host to this computer, which could not reach the host. You now run in ${cwd}. Your code and uncommitted work stay on the host, and paths from it do not exist here. Say so before you continue.`;

const killTmux = (sessionId: string) =>
	`tmux kill-session -t ${sh(tmuxSession(sessionId))} 2>/dev/null; true`;

/** Ends a remote session's tmux session on the host: Claude there stops. */
export async function endHostSession(
	host: HostLogin,
	sessionId: string,
): Promise<void> {
	const client = await connectHost(host);
	try {
		await runOnHost(client, killTmux(sessionId));
	} finally {
		client.end();
	}
}
