import { execWithShellEnv } from "../workspaces/utils/shell-env";

/**
 * Odin fork: what each live shell is running. A shell with a child process is
 * running a command (a server, a tunnel, a watcher); one without is at its
 * prompt.
 */

/**
 * `ps -axo pid=,ppid=,comm=` output, for the given shell pids: the name of
 * each shell's first child, or null when it has none. A pid that isn't in the
 * table (the shell is gone) is left out.
 */
export function parseShellCommands(
	stdout: string,
	pids: number[],
): Record<number, string | null> {
	const rows = stdout.split("\n").flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if (!match) return [];
		const [, pid, ppid, comm = ""] = match;
		// macOS prints the full path, and a login shell as "-zsh".
		const name = (comm.split("/").pop() || comm).replace(/^-/, "");
		return [{ pid: Number(pid), ppid: Number(ppid), name }];
	});
	const out: Record<number, string | null> = {};
	for (const pid of pids) {
		if (!rows.some((row) => row.pid === pid)) continue;
		out[pid] = rows.find((row) => row.ppid === pid)?.name ?? null;
	}
	return out;
}

/** One `ps` for every pid. */
export async function shellCommands(
	pids: number[],
): Promise<Record<number, string | null>> {
	if (!pids.length) return {};
	try {
		const { stdout } = await execWithShellEnv("ps", [
			"-axo",
			"pid=,ppid=,comm=",
		]);
		return parseShellCommands(stdout, pids);
	} catch {
		return {};
	}
}
