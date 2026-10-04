import { execWithShellEnv } from "../workspaces/utils/shell-env";

/**
 * Odin fork: where each live shell actually is. zsh here sends no OSC-7, so a
 * pane's `cwd` only knows where Odin opened it - the process table knows where
 * it went since.
 */

/** `lsof -Fn` output: a `p<pid>` line, then that process's `n<path>` lines. */
export function parseLsofCwds(stdout: string): Record<number, string> {
	const out: Record<number, string> = {};
	let pid = 0;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid) out[pid] = line.slice(1);
	}
	return out;
}

/** One lsof for every pid. A pid that died since just isn't in the result. */
export async function shellCwds(
	pids: number[],
): Promise<Record<number, string>> {
	if (!pids.length) return {};
	try {
		const { stdout } = await execWithShellEnv("lsof", [
			"-a",
			"-d",
			"cwd",
			"-Fn",
			"-p",
			pids.join(","),
		]);
		return parseLsofCwds(stdout);
	} catch (error) {
		// lsof exits 1 when any pid is gone, but still prints the rest.
		const stdout = (error as { stdout?: string }).stdout;
		return stdout ? parseLsofCwds(stdout) : {};
	}
}
