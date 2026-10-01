import { useEffect, useRef } from "react";
import {
	inOffHours,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useNextInLineQueue } from "../board/NextInLine";

const TICK_MS = 60_000;

/**
 * Off-hours: inside the window set in Settings → Next in line, start the top
 * of Next in line, wait for that session to stop working, start the next —
 * until the window closes or the night's ceiling is hit. One at a time, so
 * the morning is a column of finished turns rather than a pile-up.
 *
 * ponytail: renderer-side and only while Odin is open, same as automations.
 * Move it to main the day it has to run with the window shut.
 */
export function useOffHoursRunner() {
	const { start, pinned, unpinned } = useNextInLineQueue();
	const latest = useRef({ start, queue: [...pinned, ...unpinned] });
	latest.current = { start, queue: [...pinned, ...unpinned] };
	// Keys already tried this run, so a launch that doesn't take the row out
	// of the queue can't start it again every minute.
	const tried = useRef(new Set<string>());

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
			const item = latest.current.queue.find(
				(row) => !tried.current.has(row.key),
			);
			if (!item) return;
			tried.current.add(item.key);
			setOffHoursStarted(offHoursStarted + 1);
			running = true;
			try {
				await latest.current.start(item, {
					instructions: offHours.instructions,
				});
			} finally {
				running = false;
			}
		};
		const id = setInterval(() => void tick(), TICK_MS);
		return () => clearInterval(id);
	}, []);
}
