import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { publicProcedure, router } from "..";
import {
	execWithShellEnv,
	getProcessEnvWithShellPath,
} from "./workspaces/utils/shell-env";

interface GhDetectResult {
	installed: boolean;
	authenticated: boolean;
	version: string | null;
	path: string | null;
}

async function detectGhCli(): Promise<GhDetectResult> {
	// Resolve `gh` via the user's login-shell PATH (execWithShellEnv retries with
	// the derived shell env on ENOENT), so we find it wherever it's installed -
	// homebrew, MacPorts, nix, asdf, etc. - not just a hardcoded path list.
	let version: string | null = null;
	try {
		const { stdout } = await execWithShellEnv("gh", ["--version"], {
			timeout: 5000,
		});
		const firstLine = stdout.split("\n")[0]?.trim() ?? "";
		version = firstLine.match(/gh version (\S+)/)?.[1] ?? null;
	} catch {
		return {
			installed: false,
			authenticated: false,
			version: null,
			path: null,
		};
	}

	let authenticated = false;
	try {
		await execWithShellEnv(
			"gh",
			["auth", "status", "--active", "--hostname", "github.com"],
			{ timeout: 5000 },
		);
		authenticated = true;
	} catch {
		// `--active` requires gh >= 2.40; retry without it for older installs.
		// Both variants exit non-zero when not logged in.
		try {
			await execWithShellEnv(
				"gh",
				["auth", "status", "--hostname", "github.com"],
				{ timeout: 5000 },
			);
			authenticated = true;
		} catch {}
	}

	return { installed: true, authenticated, version, path: "gh" };
}

interface BrewDetectResult {
	installed: boolean;
	version: string | null;
}

async function detectBrew(): Promise<BrewDetectResult> {
	try {
		const { stdout } = await execWithShellEnv("brew", ["--version"], {
			timeout: 5000,
		});
		const version = stdout.match(/Homebrew (\S+)/)?.[1] ?? null;
		return { installed: true, version };
	} catch {
		return { installed: false, version: null };
	}
}

/**
 * Whether `claude` can start a session on this Mac: `claude auth status`.
 * `signedIn: null` means we couldn't tell (an old CLI, a Bedrock or custom
 * setup, a timeout) - the sign-in banner only ever shows on an explicit
 * `false`, so a setup we don't understand is never nagged.
 */
async function claudeAuthStatus(): Promise<{ signedIn: boolean | null }> {
	try {
		const { stdout } = await execWithShellEnv(
			"claude",
			["auth", "status", "--json"],
			{ timeout: 15_000 },
		);
		const status = JSON.parse(stdout) as { loggedIn?: unknown };
		return {
			signedIn: typeof status.loggedIn === "boolean" ? status.loggedIn : null,
		};
	} catch (error) {
		// Not signed in exits 1 with the same JSON on stdout.
		const stdout = (error as { stdout?: string }).stdout;
		try {
			const status = JSON.parse(stdout ?? "") as { loggedIn?: unknown };
			if (status.loggedIn === false) return { signedIn: false };
		} catch {}
		return { signedIn: null };
	}
}

/**
 * `claude auth login`, with no terminal: the CLI opens the browser on
 * claude.ai, you approve, and it stores the login itself - Odin never sees a
 * token. If the browser can't hand the login back, claude.ai shows a code,
 * which claudeLoginCode types into the waiting CLI.
 */
let login: ChildProcess | null = null;

/**
 * The first runnable `claude` on PATH. Node's own lookup stops at the first
 * entry it can't run (EPERM) instead of trying the next folder, so an
 * unreadable copy early on PATH would hide Odin's bundled one at the end.
 */
export function findClaude(path: string): string | null {
	for (const dir of path.split(":").filter(Boolean)) {
		const bin = join(dir, "claude");
		try {
			accessSync(bin, constants.X_OK);
			return bin;
		} catch {}
	}
	return null;
}

async function claudeLogin(): Promise<{ ok: boolean; error?: string }> {
	login?.kill();
	const env = await getProcessEnvWithShellPath();
	const bin = findClaude(env.PATH ?? "");
	if (!bin) return { ok: false, error: "Claude Code was not found." };
	let child: ChildProcess;
	try {
		child = spawn(bin, ["auth", "login", "--claudeai"], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
	login = child;
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		output += chunk;
	});
	// ponytail: abandoned logins die after 10 minutes, not on a Cancel button.
	const timer = setTimeout(() => child.kill(), 10 * 60_000);
	return new Promise((resolve) => {
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, error: error.message });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (login === child) login = null;
			resolve(
				code === 0
					? { ok: true }
					: {
							ok: false,
							error:
								output.trim().split("\n").pop()?.slice(0, 300) ||
								`claude auth login exited ${code}`,
						},
			);
		});
	});
}

export const createSystemRouter = () => {
	return router({
		detectGhCli: publicProcedure.query(detectGhCli),
		detectBrew: publicProcedure.query(detectBrew),
		claudeAuthStatus: publicProcedure.query(claudeAuthStatus),
		claudeLogin: publicProcedure.mutation(claudeLogin),
		claudeLoginCode: publicProcedure
			.input(z.object({ code: z.string().trim().min(1) }))
			.mutation(({ input }) => {
				if (!login?.stdin?.writable) return { sent: false };
				login.stdin.write(`${input.code}\n`);
				return { sent: true };
			}),
		/**
		 * A pasted screenshot has no file behind it, and a task is one string in
		 * localStorage - so the bytes land in ~/.odin/attachments and the task
		 * keeps the path. ponytail: never cleaned up, prune by age if it grows.
		 */
		saveAttachment: publicProcedure
			.input(
				z.object({
					base64: z.string(),
					extension: z.string().regex(/^[a-z0-9]{1,8}$/i),
				}),
			)
			.mutation(async ({ input }) => {
				const dir = join(homedir(), ".odin", "attachments");
				await mkdir(dir, { recursive: true });
				const path = join(
					dir,
					`${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${input.extension}`,
				);
				await writeFile(path, Buffer.from(input.base64, "base64"));
				return path;
			}),
	});
};

export type SystemRouter = ReturnType<typeof createSystemRouter>;
