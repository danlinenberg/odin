import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sh } from "./session";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

/**
 * Parts of the user's Claude Code setup (~/.claude) they can copy to the
 * remote host, so sessions there work as they do here. Never the login or
 * accounts (.credentials.json, ~/.claude.json), conversations or history.
 */
export const CLAUDE_SETUP_PARTS = [
	"instructions",
	"skills",
	"commands",
	"plugins",
	"settings",
] as const;
export type ClaudeSetupPart = (typeof CLAUDE_SETUP_PARTS)[number];

/**
 * After a sync, on the host: hooks (settings.json's and plugins') and the
 * status line whose command names a file the host doesn't have - a Mac app,
 * a repo that isn't cloned there - are dropped from the host's copy, so they
 * don't fail on every tool call. Prints what it dropped, as JSON.
 */
export const PRUNE_HOOKS_PY = `import glob, json, os, shlex
home = os.path.expanduser("~")


def missing(command):
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    for token in tokens:
        if token.startswith("$HOME/"):
            token = home + token[5:]
        elif token.startswith("~/"):
            token = os.path.expanduser(token)
        elif "$" in token:
            continue
        if token.startswith("/") and not os.path.exists(token):
            return token
    return None


dropped = []


def prune(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        return
    changed = False
    line = data.get("statusLine")
    if isinstance(line, dict) and missing(line.get("command", "")):
        dropped.append("statusLine: " + missing(line["command"]))
        del data["statusLine"]
        changed = True
    hooks = data.get("hooks")
    if isinstance(hooks, dict):
        for event in list(hooks):
            groups = hooks[event] if isinstance(hooks[event], list) else []
            for group in groups:
                kept = []
                for hook in group.get("hooks", []):
                    gone = missing(hook.get("command", "")) if hook.get("type") == "command" else None
                    if gone:
                        dropped.append(event + ": " + gone)
                        changed = True
                    else:
                        kept.append(hook)
                group["hooks"] = kept
            hooks[event] = [g for g in groups if g.get("hooks")]
            if not hooks[event]:
                del hooks[event]
    if changed:
        with open(path, "w") as f:
            json.dump(data, f, indent=2)


root = os.path.expanduser("~/.claude")
for path in [root + "/settings.json"] + glob.glob(root + "/plugins/**/hooks/hooks.json", recursive=True):
    prune(path)
print(json.dumps(sorted(set(dropped))))
`;

/** Files CLAUDE.md pulls in with `@file` lines, when they live in ~/.claude. */
export function claudeMdImports(claudeMd: string): string[] {
	return claudeMd
		.split("\n")
		.map((line) => line.trim().match(/^@(\S+)$/)?.[1])
		.filter((path): path is string => !!path && !path.includes(".."))
		.map((path) => path.replace(/^~\/\.claude\//, ""))
		.filter((path) => !path.startsWith("/") && !path.startsWith("~"));
}

/** The paths under ~/.claude each part copies; ones that don't exist are skipped. */
export function partPaths(part: ClaudeSetupPart, root: string): string[] {
	const paths = {
		instructions: () => {
			const md = join(root, "CLAUDE.md");
			return existsSync(md)
				? ["CLAUDE.md", ...claudeMdImports(readFileSync(md, "utf-8"))]
				: [];
		},
		skills: () => ["skills"],
		commands: () => ["commands", "agents"],
		plugins: () => [
			"plugins/installed_plugins.json",
			"plugins/known_marketplaces.json",
			"plugins/blocklist.json",
			"plugins/marketplaces",
			"plugins/cache",
		],
		settings: () => ["settings.json", "hooks"],
	}[part]();
	return paths.filter((path) => existsSync(join(root, path)));
}

/**
 * Copies the chosen parts to ~/.claude on the host: one tar stream over SSH
 * stdin, unpacked there, then this computer's home path rewritten to the
 * host user's in the files that name it. Returns the bytes sent.
 */
export async function syncClaudeSetup(
	host: HostLogin,
	parts: readonly ClaudeSetupPart[],
): Promise<{ bytes: number; dropped: string[] }> {
	const root = join(homedir(), ".claude");
	const paths = [...new Set(parts.flatMap((part) => partPaths(part, root)))];
	if (!paths.length) return { bytes: 0, dropped: [] };
	const client = await connectHost(host);
	try {
		const unpack = [
			"mkdir -p ~/.claude && tar -xzf - -C ~/.claude",
			// The files that carry absolute paths: this computer's home becomes the host's.
			`grep -rlF ${sh(homedir())} ~/.claude/settings.json ~/.claude/CLAUDE.md ~/.claude/*.md ~/.claude/plugins/installed_plugins.json ~/.claude/plugins/known_marketplaces.json 2>/dev/null | xargs -r sed -i "s#${homedir()}#$HOME#g"`,
		].join(" && ");
		const bytes = await new Promise<number>((resolve, reject) => {
			client.exec(unpack, (err, stream) => {
				if (err) return reject(err);
				let errors = "";
				let bytes = 0;
				stream.stderr.on("data", (chunk: Buffer) => {
					errors += chunk;
				});
				// ssh2 fires "close" only after stdout ends, and an unread stdout never ends.
				stream.resume();
				stream.on("close", (code: number) =>
					code === 0
						? resolve(bytes)
						: reject(new Error(errors.trim() || `exit ${code}`)),
				);
				const tar = spawn(
					"tar",
					[
						"-czf",
						"-",
						"--exclude",
						".DS_Store",
						"--exclude",
						"node_modules",
						"-C",
						root,
						...paths,
					],
					{ env: { ...process.env, COPYFILE_DISABLE: "1" } },
				);
				tar.stdout.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
				});
				tar.stdout.pipe(stream);
				tar.on("error", reject);
			});
		});
		const dropped = JSON.parse(
			(await runOnHost(client, `python3 -c ${sh(PRUNE_HOOKS_PY)}`)) || "[]",
		) as string[];
		return { bytes, dropped };
	} finally {
		client.end();
	}
}
