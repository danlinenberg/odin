import { useEffect, useRef } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	inOffHours,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useNextInLineQueue } from "../board/NextInLine";

const TICK_MS = 60_000;

/**
 * What the night's ranking was asked with, and what it said. `seen` is every
 * row it was shown, so a row that arrived since forces a fresh one.
 */
interface NightRanking {
	instructions: string;
	seen: Set<string>;
	order: Map<string, number>;
	hidden: Set<string>;
}

/** Your sort words plus the Night Agent ones — what the night ranking obeys. */
export function nightInstructions(sort: string, offHours: string): string {
	return [
		sort,
		offHours &&
			`For the overnight run, which starts these one by one while I'm away:\n${offHours}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * Night Agent: inside the window set in Settings → Backlog, start the top
 * of Next in line, wait for that session to stop working, start the next —
 * until the window closes or the night's ceiling is hit. One at a time, so
 * the morning is a column of finished turns rather than a pile-up.
 *
 * Which row is "the top" is the model's call, asked with your sort words and
 * the Night Agent instructions, so "don't include X" in either keeps X out.
 * Asked again before a start whenever the words changed or new rows came in:
 * an edit applies to the very next session.
 *
 * ponytail: renderer-side and only while Odin is open, same as automations.
 * Move it to main the day it has to run with the window shut.
 */
export function useNightAgentRunner() {
	const queue = useNextInLineQueue(true);
	const latest = useRef(queue);
	latest.current = queue;
	// Keys already tried this run, so a launch that doesn't take the row out
	// of the queue can't start it again every minute.
	const tried = useRef(new Set<string>());
	const night = useRef<NightRanking | null>(null);

	useEffect(() => {
		let running = false;
		const tick = async () => {
			if (running) return;
			const { offHours, offHoursStarted, setOffHoursStarted } =
				useNextInLinePrompt.getState();
			if (!offHours.enabled) return;
			if (!inOffHours(new Date(), offHours.start, offHours.end)) {
				if (offHoursStarted) setOffHoursStarted(0);
				tried.current.clear();
				night.current = null;
				return;
			}
			if (offHoursStarted >= offHours.maxSessions) return;
			// Still working, or held by the launch gate: the last one isn't done.
			const busy = Object.values(useTabsStore.getState().panes).some(
				(pane) =>
					!pane.completed &&
					pane.odinTags?.includes("off-hours") &&
					(pane.status === "working" || !!pane.odinQueued),
			);
			if (busy) return;
			running = true;
			try {
				const { waiting, rankInput, prompt } = latest.current;
				const instructions = nightInstructions(prompt, offHours.instructions);
				const stale =
					night.current?.instructions !== instructions ||
					waiting.some((row) => !night.current?.seen.has(row.key));
				if (stale) {
					// A failed ranking starts nothing: without it, nothing says which
					// rows your instructions rule out.
					const ranking =
						await electronTrpcClient.backlogReview.rankNextInLine.query({
							...rankInput(waiting),
							instructions,
							fresh: true,
						});
					night.current = {
						instructions,
						seen: new Set(waiting.map((row) => row.key)),
						order: new Map(ranking.keys.map((key, i) => [key, i])),
						hidden: new Set(ranking.hidden),
					};
					console.warn(
						`[night-agent] ranked ${waiting.length}; ruled out:`,
						waiting
							.filter((row) => ranking.hidden.includes(row.key))
							.map((row) => row.title),
					);
				}
				const { order, hidden } = night.current as NightRanking;
				const { pinned, unpinned, start } = latest.current;
				const rank = (key: string) => order.get(key) ?? order.size;
				const item = [
					...pinned,
					...unpinned.toSorted((a, b) => rank(a.key) - rank(b.key)),
				].find((row) => !hidden.has(row.key) && !tried.current.has(row.key));
				if (!item) return;
				tried.current.add(item.key);
				setOffHoursStarted(offHoursStarted + 1);
				await start(item, { instructions: offHours.instructions });
			} catch (error) {
				console.warn("[night-agent] ranking failed, starting nothing:", error);
			} finally {
				running = false;
			}
		};
		const id = setInterval(() => void tick(), TICK_MS);
		return () => clearInterval(id);
	}, []);
}
