import { statfsSync } from "node:fs";
import { constants, homedir } from "node:os";

/**
 * Why a session's terminal ended, in a few words for its board card. Read at
 * the moment it ends: a full disk is freed later and the reason with it.
 * Undefined when Odin closed it on purpose - that one needs no explaining.
 */
export function exitCause(
	exitCode: number,
	signal: number | undefined,
	reason: "killed" | "exited" | "error" | undefined,
): string | undefined {
	if (reason === "killed") return undefined;
	const signalName = Object.entries(constants.signals).find(
		([, number]) => number === signal,
	)?.[0];
	const how = signal
		? `killed by ${signalName ?? `signal ${signal}`}`
		: exitCode === 0
			? "exited"
			: `crashed (exit ${exitCode})`;
	try {
		const { bavail, bsize } = statfsSync(homedir());
		const freeGb = (bavail * bsize) / 1024 ** 3;
		// ponytail: under 2 GB reads as the cause - a guess, not a proof.
		if (freeGb < 2) return `${how} - disk full (${freeGb.toFixed(1)} GB free)`;
	} catch {}
	return how;
}

if (import.meta.main) {
	const assert = (ok: boolean, what: string) => {
		if (!ok) throw new Error(what);
	};
	assert(exitCause(0, undefined, "killed") === undefined, "Odin's own kill");
	const crashed = exitCause(1, undefined, "exited") ?? "";
	assert(crashed.startsWith("crashed (exit 1)"), crashed);
	const killed = exitCause(0, 9, "exited") ?? "";
	assert(killed.startsWith("killed by SIGKILL"), killed);
	console.log("ok");
}
