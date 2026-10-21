import { z } from "zod";
import { publicProcedure, router } from "..";
import { execWithShellEnv } from "./workspaces/utils/shell-env";

/** Enough for any repo you'd type a path from, small enough to send whole. */
export const FILE_CAP = 5000;

/**
 * Odin fork: the files of a session's checkout, for the chat reply box's `@`
 * picker. `git ls-files` skips what .gitignore hides (node_modules, builds)
 * and answers fast; new files not committed yet come after the tracked ones.
 * A folder that isn't a git checkout, or isn't on this computer, has none.
 * Odin's own notes under `.odin/` (task-*.md) are not the session's files.
 */
export async function listSessionFiles(
	cwd: string,
	cap = FILE_CAP,
): Promise<string[]> {
	try {
		const { stdout } = await execWithShellEnv(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ cwd, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
		);
		const files = new Set<string>();
		for (const path of stdout.split("\0")) {
			if (files.size >= cap) break;
			if (path && !isOdinOwn(path)) files.add(path);
		}
		return [...files];
	} catch {
		return [];
	}
}

function isOdinOwn(path: string): boolean {
	return path.startsWith(".odin/") || path.includes("/.odin/");
}

export const createSessionFilesRouter = () => {
	return router({
		list: publicProcedure
			.input(z.object({ cwd: z.string().min(1) }))
			.query(({ input }) => listSessionFiles(input.cwd)),
	});
};
