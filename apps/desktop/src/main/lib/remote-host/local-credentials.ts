import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";

/**
 * Files and env vars from this computer that the user brings to the remote
 * host, one by one (Settings > Remote > What the host gets): a Snowflake
 * private key, a tool's config, SNOWFLAKE_ACCOUNT. Nothing goes by default.
 * Each file lands at the same place under the host user's own home, mode
 * 0600; the env vars go to ~/.odin/local-env there, mode 0600, which that
 * user's sessions read at start (session.ts runScript). Values are never
 * logged: what fails or is missing is said by name only.
 */

/** Where the env vars land on the host, under the host user's home. */
export const LOCAL_ENV_FILE = ".odin/local-env";

/** A name a shell can export, and not one the session sets itself. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TMUX",
	"TMUX_PANE",
	"TERM",
	"ODIN_PORT",
	"ODIN_PANE_ID",
]);

export const isBringableEnvName = (name: string) =>
	ENV_NAME.test(name) && !RESERVED.has(name) && !name.startsWith("ODIN_");

/**
 * A file the user listed, as a path under their home: `~/x`, `$HOME/x` or an
 * absolute path inside the home folder. Null for anything else (outside home,
 * the home folder itself, a `..` that climbs out).
 */
export function homeRelative(path: string, home = homedir()): string | null {
	const trimmed = path.trim();
	if (!trimmed) return null;
	const expanded = trimmed.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
	if (!isAbsolute(expanded)) return null;
	const rel = relative(home, normalize(expanded));
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel;
}

/** Why a listed file or env var name can't go, or null when it can. */
export function bringProblem(
	kind: "file" | "env",
	entry: string,
): string | null {
	if (kind === "file")
		return homeRelative(entry)
			? null
			: `${entry} is not a file in your home folder`;
	return isBringableEnvName(entry)
		? null
		: `${entry} is not an env var name Odin can bring`;
}

export interface CredentialsPayload {
	/** Paths under the host user's home, with the file's bytes as base64. */
	files: { path: string; data: string }[];
	/** Name and value; [] removes the env file on the host. */
	env: [string, string][];
}

/**
 * What goes to the host: the listed files that exist here and the listed env
 * vars that are set (from `env`, the user's shell environment). `missing`
 * names the rest, never a value.
 */
export async function credentialsPayload(
	files: readonly string[],
	envNames: readonly string[],
	env: Record<string, string | undefined>,
	home = homedir(),
): Promise<{ payload: CredentialsPayload; missing: string[] }> {
	const missing: string[] = [];
	const payload: CredentialsPayload = { files: [], env: [] };
	for (const entry of files) {
		const rel = homeRelative(entry, home);
		if (!rel) {
			missing.push(entry);
			continue;
		}
		const data = await readFile(join(home, rel)).catch(() => null);
		if (data) payload.files.push({ path: rel, data: data.toString("base64") });
		else missing.push(entry);
	}
	for (const name of envNames) {
		const value = env[name];
		if (isBringableEnvName(name) && value !== undefined)
			payload.env.push([name, value]);
		else missing.push(`$${name}`);
	}
	return { payload, missing };
}

/**
 * Run with python3 as the host user, the payload as JSON on stdin. Each file
 * is written under $HOME with mode 0600 (new folders 0700), never through a
 * symlink and never outside $HOME. The env vars replace ~/.odin/local-env
 * (0600) as `export NAME='value'` lines; none removes it. Prints nothing, and
 * a failure names the path, not the contents.
 */
export const WRITE_CREDENTIALS_PY = `
import json, os, sys
home = os.path.realpath(os.path.expanduser("~"))
data = json.load(sys.stdin)
def write(rel, body):
    path = os.path.normpath(os.path.join(home, rel))
    if not path.startswith(home + os.sep):
        raise SystemExit("not under home: " + rel)
    parent = os.path.dirname(path)
    os.makedirs(parent, mode=0o700, exist_ok=True)
    if not os.path.realpath(parent).startswith(home):
        raise SystemExit("not under home: " + rel)
    tmp = path + ".odin-tmp"
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, body)
    finally:
        os.close(fd)
    os.replace(tmp, path)
import base64
for f in data.get("files", []):
    write(f["path"], base64.b64decode(f["data"]))
env = data.get("env", [])
target = os.path.join(home, ${JSON.stringify(LOCAL_ENV_FILE)})
if env:
    q = lambda v: "'" + v.replace("'", "'\\\\''") + "'"
    write(${JSON.stringify(LOCAL_ENV_FILE)}, "".join("export %s=%s\\n" % (k, q(v)) for k, v in env).encode())
else:
    try:
        os.unlink(target)
    except FileNotFoundError:
        pass
`;

/** Run-script line: the env vars the user brought, for this user's sessions only. */
export const LOCAL_ENV_SCRIPT = `[ -f "$HOME/${LOCAL_ENV_FILE}" ] && . "$HOME/${LOCAL_ENV_FILE}"; true`;
