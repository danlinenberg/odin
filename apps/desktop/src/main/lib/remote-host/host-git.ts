import type { Client } from "ssh2";
import type { CheckoutResolver } from "../claude-sessions";
import { sh } from "./session";

/**
 * Runs a shell command on the host, `input` on its stdin. Unlike runOnHost it
 * keeps stdout whole and hands back the exit code: `git diff --no-index`
 * exits 1 with the patch on stdout.
 */
export type HostExec = (
	command: string,
	input?: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** `HostExec` over an open SSH connection to the host. */
export const clientExec =
	(client: Client): HostExec =>
	(command, input = "") =>
		new Promise((resolve, reject) =>
			client.exec(command, (err, stream) => {
				if (err) return reject(err);
				const out: Buffer[] = [];
				const errors: Buffer[] = [];
				stream
					.on("data", (chunk: Buffer) => out.push(chunk))
					.on("close", (code: number | undefined) =>
						resolve({
							stdout: Buffer.concat(out).toString("utf8"),
							stderr: Buffer.concat(errors).toString("utf8"),
							code: code ?? 0,
						}),
					);
				stream.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
				stream.end(input);
			}),
		);

/**
 * Runs git in `cwd` on the host and resolves to its stdout. A non-zero exit
 * rejects with an error carrying `stdout`, as execFile does, so the diff code
 * treats it the same as git on this computer.
 */
export const hostGit =
	(exec: HostExec, cwd: string) =>
	async (args: string[], env?: Record<string, string>): Promise<string> => {
		const vars = Object.entries(env ?? {}).map(
			([key, value]) => `${key}=${sh(value)} `,
		);
		const { stdout, stderr, code } = await exec(
			`cd ${sh(cwd)} && ${vars.join("")}git ${args.map(sh).join(" ")}`,
		);
		if (code !== 0)
			throw Object.assign(new Error(stderr.trim() || `git exit ${code}`), {
				stdout,
			});
		return stdout;
	};

/**
 * The checkout as it is now written as a git tree, on the host: the same as
 * snapshotTree here. A copy of the index takes the `add`, so the real index,
 * the refs and the files are never touched.
 */
export function hostSnapshotScript(cwd: string): string {
	return [
		`cd ${sh(cwd)} || exit 1`,
		'idx=$(git rev-parse --git-path index) || exit 1; case "$idx" in /*) ;; *) idx="$PWD/$idx" ;; esac',
		"tmp=$(mktemp -d) || exit 1; trap 'rm -rf \"$tmp\"' EXIT",
		'export GIT_INDEX_FILE="$tmp/index"',
		'if [ -f "$idx" ]; then cp "$idx" "$GIT_INDEX_FILE"; else git read-tree HEAD; fi || exit 1',
		"git add -A && git write-tree",
	].join("\n");
}

export async function hostSnapshot(
	exec: HostExec,
	cwd: string,
): Promise<string> {
	const { stdout, stderr, code } = await exec(hostSnapshotScript(cwd));
	if (code !== 0) throw new Error(stderr.trim() || `snapshot exit ${code}`);
	return stdout.trim();
}

/**
 * For each folder on stdin (a JSON list), its checkout and the repo owning
 * that checkout, the way repoRootOf and ownerRepoOf answer here: the nearest
 * folder up with a `.git`, and for a worktree the clone its `.git` file points
 * into. Prints {folder: [checkout, owner]}, null for a folder outside a repo.
 */
export const HOST_CHECKOUTS = `import json, os, re, sys
out = {}
for d in json.load(sys.stdin):
    c = d
    while not os.path.exists(os.path.join(c, ".git")):
        p = os.path.dirname(c)
        if p == c:
            c = None
            break
        c = p
    if c is None:
        out[d] = None
        continue
    owner = c
    g = os.path.join(c, ".git")
    try:
        if os.path.isfile(g):
            m = re.search(r"^gitdir:\\s*(.+?)\\s*$", open(g).read(), re.M)
            o = m and re.match(r"^(.*)/\\.git/worktrees/", m.group(1))
            if o:
                owner = o.group(1)
    except OSError:
        pass
    out[d] = [c, owner]
print(json.dumps(out))
`;

/**
 * How the host maps the folders a remote session's transcript names to
 * checkouts and repos. Its transcript's paths are the host's, and none of
 * them is a folder on this computer, so the Diff tab asks the host once.
 */
export async function hostCheckouts(
	exec: HostExec,
	dirs: string[],
): Promise<CheckoutResolver> {
	const answers = new Map<string, [string, string] | null>();
	if (dirs.length) {
		const { stdout, stderr, code } = await exec(
			`python3 -c ${sh(HOST_CHECKOUTS)}`,
			JSON.stringify(dirs),
		);
		if (code !== 0) throw new Error(stderr.trim() || `checkouts exit ${code}`);
		const parsed = JSON.parse(stdout) as Record<
			string,
			[string, string] | null
		>;
		for (const [dir, answer] of Object.entries(parsed))
			answers.set(dir, answer);
	}
	const owners = new Map<string, string>();
	for (const answer of answers.values())
		if (answer) owners.set(answer[0], answer[1]);
	return {
		rootOf: (dir) => answers.get(dir)?.[0] ?? null,
		ownerOf: (checkout) => owners.get(checkout) ?? checkout,
	};
}
