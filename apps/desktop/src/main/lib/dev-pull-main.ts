import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { app, powerMonitor } from "electron";

const run = promisify(execFile);
const EVERY_MS = 2 * 60 * 1000;
// A pull can full-reload the renderer, so it waits until you step away.
const IDLE_SECONDS = 5 * 60;

/**
 * Fast-forward `repo` to origin/main when it sits on main with no local
 * changes to tracked files. Anything else is left alone: another branch, or
 * work not committed yet. Returns what it did, for the log.
 */
export async function pullMainIfClean(
	repo: string,
): Promise<"pulled" | "current" | "skipped"> {
	const git = async (...args: string[]) =>
		(await run("git", ["-C", repo, ...args])).stdout.trim();
	if ((await git("branch", "--show-current")) !== "main") return "skipped";
	if (await git("status", "--porcelain", "--untracked-files=no"))
		return "skipped";
	await git("fetch", "--quiet", "origin", "main");
	if ((await git("rev-list", "--count", "HEAD..origin/main")) === "0")
		return "current";
	await git("merge", "--ff-only", "--quiet", "origin/main");
	return "pulled";
}

/**
 * A dev Odin runs from a checkout: keep it on the newest main, so a merged PR
 * reaches the app (renderer edits hot-reload; main-process ones on the next
 * restart) without a manual git pull. It pulls only while you're idle, since
 * a pull can reload the whole window mid-work.
 */
export function startDevMainPuller(): void {
	if (process.env.NODE_ENV !== "development") return;
	// apps/desktop is two levels below the checkout's root.
	const repo = path.resolve(app.getAppPath(), "../..");
	const tick = () => {
		if (powerMonitor.getSystemIdleTime() < IDLE_SECONDS) return;
		return pullMainIfClean(repo)
			.then((result) => {
				if (result === "pulled") console.log(`[dev] pulled main in ${repo}`);
			})
			.catch((error: unknown) => console.error("[dev] pull main:", error));
	};
	setInterval(tick, EVERY_MS).unref();
	void tick();
}
