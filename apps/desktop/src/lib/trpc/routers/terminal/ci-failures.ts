import { execWithShellEnv } from "../workspaces/utils/shell-env";
import { type GhExec, ghAsAnyAccount } from "./pr-state";

/**
 * Odin fork: what broke in a PR's CI, for the message that wakes its session.
 * The check names say which job went red; the failed step's log says why, so
 * the agent can fix it without a round of `gh run view` first.
 */

export interface FailedCheck {
	name: string;
	/** The check's page: an Actions job, or a bot's own site. */
	link: string | null;
	/** The failed step's log, cut to the lines around the error. */
	log: string | null;
}

interface RollupEntry {
	name?: string;
	context?: string;
	status?: string;
	conclusion?: string;
	state?: string;
	workflowName?: string;
	startedAt?: string;
	detailsUrl?: string;
	targetUrl?: string;
}

const gh: GhExec = (args, env) => execWithShellEnv("gh", args, { env });

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"]);

/** `.../actions/runs/<run>/job/<job>`: an Actions job whose log gh can read. */
const ACTIONS_JOB =
	/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)\/job\/(\d+)/;

/** A line that says what went wrong, in the logs CI tools print. */
const TELLING =
	/error|fail|broken|✗|✘|not ok|exception|panic|assert|expected|received/i;

/** Lines kept per job, around the errors. */
const MAX_LINES = 60;
const CONTEXT = 2;
/** Jobs read per PR: a matrix that all went red says the same thing N times. */
const MAX_JOBS = 4;

/**
 * `gh run view --log-failed` prints `job<TAB>step<TAB>timestamp text`. Keep
 * the text, minus colour codes and the runner's group markers, and only the
 * lines near an error - the tail of a test run is its summary, the failure is
 * further up. With nothing telling, the last lines.
 */
export function logExcerpt(raw: string): string | null {
	const lines = raw
		.split("\n")
		.map((line) =>
			line
				.replace(/^[^\t]*\t[^\t]*\t/, "")
				.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
				// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes
				.replace(/\u001b\[[\d;]*m/g, "")
				.trimEnd(),
		)
		.filter((line) => line && !/^##\[(end)?group\]/.test(line));
	if (!lines.length) return null;
	const keep = new Set<number>();
	lines.forEach((line, i) => {
		if (!TELLING.test(line)) return;
		for (let j = i - CONTEXT; j <= i + CONTEXT; j++)
			if (j >= 0 && j < lines.length) keep.add(j);
	});
	const picked = keep.size
		? [...keep].sort((a, b) => a - b).map((i) => lines[i] as string)
		: lines;
	return picked.slice(-MAX_LINES).join("\n");
}

/** The newest run of each check that failed, with its link. */
export function failedEntries(entries: RollupEntry[]): RollupEntry[] {
	const latest = new Map<string, RollupEntry>();
	for (const entry of entries) {
		const key = `${entry.workflowName ?? ""}/${entry.name ?? entry.context}`;
		const seen = latest.get(key);
		if (!seen || (entry.startedAt ?? "") >= (seen.startedAt ?? ""))
			latest.set(key, entry);
	}
	return [...latest.values()].filter((entry) =>
		FAILED.has(entry.conclusion ?? entry.state ?? ""),
	);
}

/** The failed checks on a PR, each with its log when it is an Actions job. */
export async function failedChecks(
	url: string,
	exec: GhExec = gh,
): Promise<FailedCheck[]> {
	const rollup =
		(await ghAsAnyAccount(
			["pr", "view", url, "--json", "statusCheckRollup"],
			(stdout) =>
				(JSON.parse(stdout) as { statusCheckRollup?: RollupEntry[] | null })
					.statusCheckRollup ?? [],
			exec,
		)) ?? [];
	const failed = failedEntries(rollup);
	let read = 0;
	return Promise.all(
		failed.map(async (entry) => {
			const link = entry.detailsUrl || entry.targetUrl || null;
			const job = link ? ACTIONS_JOB.exec(link) : null;
			let log: string | null = null;
			if (job && read++ < MAX_JOBS) {
				const [, repo = "", run = "", id = ""] = job;
				log = await ghAsAnyAccount(
					["run", "view", run, "--job", id, "--log-failed", "-R", repo],
					logExcerpt,
					exec,
				);
			}
			return { name: entry.name ?? entry.context ?? "check", link, log };
		}),
	);
}
