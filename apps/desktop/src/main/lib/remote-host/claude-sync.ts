import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Client } from "ssh2";
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
 * The sync under way, kept here rather than in the Settings page, so it goes
 * on when the page is left and shows again when it is opened: the parts
 * being copied, and the parts asked for meanwhile, which go out as one more
 * sync when this one lands (the latest set asked for).
 */
let syncing: {
	parts: readonly ClaudeSetupPart[];
	next: readonly ClaudeSetupPart[] | null;
	done: Promise<void>;
} | null = null;
/** Why the last sync failed; cleared when the next one starts. */
let syncError: string | null = null;

export function claudeSyncStatus(): {
	parts: readonly ClaudeSetupPart[] | null;
	next: readonly ClaudeSetupPart[] | null;
	error: string | null;
} {
	return {
		parts: syncing?.parts ?? null,
		next: syncing?.next ?? null,
		error: syncError,
	};
}

/**
 * Has `copy` run with `parts` now, or after the sync under way when there is
 * one (a set asked for meanwhile replaces an earlier one). Settles once every
 * sync asked for has landed; a failed one is kept in the status, never thrown.
 */
export function requestClaudeSync(
	parts: readonly ClaudeSetupPart[],
	copy: (parts: readonly ClaudeSetupPart[]) => Promise<void>,
): Promise<void> {
	if (syncing) {
		syncing.next = parts;
		return syncing.done;
	}
	const state = { parts, next: null, done: Promise.resolve() };
	syncing = state;
	state.done = (async () => {
		let todo: readonly ClaudeSetupPart[] | null = parts;
		while (todo) {
			state.parts = todo;
			state.next = null;
			syncError = null;
			try {
				await copy(todo);
			} catch (err) {
				syncError = err instanceof Error ? err.message : String(err);
			}
			todo = state.next;
		}
		syncing = null;
	})();
	return state.done;
}

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
 * Runs `command` on the host with `source` streamed to its stdin. Resolves
 * with the bytes sent once the command exits 0; else rejects with its stderr.
 */
export function streamToHost(
	client: Client,
	command: string,
	source: Readable,
): Promise<number> {
	return new Promise((resolve, reject) => {
		client.exec(command, (err, stream) => {
			if (err) return reject(err);
			let errors = "";
			let bytes = 0;
			// ssh2 reports the channel closed only after its stdout has ended,
			// and a stdout nobody reads never ends: unread, this promise would
			// hang forever once the command is done.
			stream.resume();
			stream.stderr.on("data", (chunk: Buffer) => {
				errors += chunk;
			});
			stream.on("close", (code: number) =>
				code === 0
					? resolve(bytes)
					: reject(new Error(errors.trim() || `exit ${code}`)),
			);
			source.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
			});
			source.on("error", reject);
			source.pipe(stream);
		});
	});
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
		// Read, so tar can't stall on a full stderr pipe; what it said joins the error.
		let tarErrors = "";
		tar.stderr.on("data", (chunk: Buffer) => {
			tarErrors += chunk;
		});
		const bytes = await new Promise<number>((resolve, reject) => {
			tar.once("error", reject);
			streamToHost(client, unpack, tar.stdout).then(resolve, reject);
		}).catch((error: Error) => {
			throw new Error(
				[error.message, tarErrors.trim()].filter(Boolean).join("\n"),
			);
		});
		const dropped = JSON.parse(
			(await runOnHost(client, `python3 -c ${sh(PRUNE_HOOKS_PY)}`)) || "[]",
		) as string[];
		return { bytes, dropped };
	} finally {
		client.end();
	}
}
