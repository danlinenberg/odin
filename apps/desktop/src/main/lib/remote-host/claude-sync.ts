import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sh } from "./session";
import { connectHost, type HostLogin } from "./ssh";

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
): Promise<number> {
	const root = join(homedir(), ".claude");
	const paths = [...new Set(parts.flatMap((part) => partPaths(part, root)))];
	if (!paths.length) return 0;
	const client = await connectHost(host);
	try {
		const unpack = [
			"mkdir -p ~/.claude && tar -xzf - -C ~/.claude",
			// The files that carry absolute paths: this computer's home becomes the host's.
			`grep -rlF ${sh(homedir())} ~/.claude/settings.json ~/.claude/CLAUDE.md ~/.claude/*.md ~/.claude/plugins/installed_plugins.json ~/.claude/plugins/known_marketplaces.json 2>/dev/null | xargs -r sed -i "s#${homedir()}#$HOME#g"`,
		].join(" && ");
		return await new Promise<number>((resolve, reject) => {
			client.exec(unpack, (err, stream) => {
				if (err) return reject(err);
				let errors = "";
				let bytes = 0;
				stream.stderr.on("data", (chunk: Buffer) => {
					errors += chunk;
				});
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
	} finally {
		client.end();
	}
}
