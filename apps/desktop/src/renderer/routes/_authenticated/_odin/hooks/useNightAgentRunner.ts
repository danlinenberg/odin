import { useEffect, useRef } from "react";
import {
	isRemoteCoreMode,
	runsLocalSchedulers,
} from "renderer/lib/remote-core-link";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	inOffHours,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useTabsStore } from "renderer/stores/tabs/store";
import { nightInstructions } from "shared/night-agent";
import { NIGHT_QUEUE_KEY, type NightQueue } from "shared/server-board";
import { useNextInLineQueue } from "../board/NextInLine";
import { mirrorJson } from "./state-mirror";

const TICK_MS = 60_000;
/** Ticks this far apart mean the runner wasn't running in between. */
const GAP_MS = 5 * TICK_MS;
/** How often the queue goes up to a remote server's Night Agent. */
const QUEUE_PUSH_MS = 30_000;

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

export { nightInstructions } from "shared/night-agent";

/**
 * Next in line as the server's Night Agent reads it (main/odin-core/scheduler):
 * every waiting row, due-pinned first, with what starting it takes.
 */
export function nightQueueOf(
	queue: ReturnType<typeof useNextInLineQueue>,
): NightQueue {
	const pinned = new Set(queue.pinned.map((item) => item.key));
	const rows = [
		...queue.pinned,
		...queue.waiting.filter((item) => !pinned.has(item.key)),
	];
	const ranked = queue.rankInput(rows).items;
	return {
		prompt: queue.prompt,
		rows: rows.map((item, index) => ({
			key: item.key,
			title: item.title,
			source: item.source,
			launch: item.launch,
			pinned: pinned.has(item.key),
			duplicate: !!queue.duplicateFor(item),
			rank: ranked[index] as NightQueue["rows"][number]["rank"],
		})),
	};
}

/**
 * Night Agent: inside the window set in Settings → Backlog, start the top
 * of Next in line, wait for that session to stop working, start the next -
 * until the window closes or the night's ceiling is hit. One at a time, so
 * the morning is a column of finished turns rather than a pile-up.
 *
 * Which row is "the top" is the model's call, asked with your sort words and
 * the Night Agent instructions, so "don't include X" in either keeps X out.
 * Asked again before a start whenever the words changed or new rows came in:
 * an edit applies to the very next session.
 *
 * Odin keeps the computer from idle sleep meanwhile, so no Caffeinate is
 * needed. It runs only on power: on battery it starts nothing and lets go. A closed laptop lid still sleeps it: no app can stop that.
 *
 * On a remote server it runs there instead (main/odin-core/scheduler.ts), so it
 * works with the laptop shut: this only sends it the queue.
 *
 * Every decision lands in the store's `nightLog`, so Huginn (and you) can
 * say what ran and why a night started nothing.
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
		let awake = false;
		// Idle sleep would stop the tick and the sessions with it, so Odin holds
		// it off itself for the window, and past it while the last one works.
		const keepAwake = (next: boolean) => {
			if (next === awake) return;
			awake = next;
			void electronTrpcClient.device.keepAwake.mutate(next).catch(() => {
				awake = !next;
			});
		};
		const tick = async () => {
			if (running) return;
			if (!runsLocalSchedulers()) return keepAwake(false);
			const {
				offHours,
				offHoursStarted,
				offHoursFromPicks,
				setOffHours,
				setOffHoursStarted,
				setOffHoursFromPicks,
				logNight,
				nightLastTick,
				setNightLastTick,
			} = useNextInLinePrompt.getState();
			// Still working, or held by the launch gate: the last one isn't done.
			const busy = Object.values(useTabsStore.getState().panes).find(
				(pane) =>
					!pane.completed &&
					pane.odinTags?.includes("off-hours") &&
					(pane.status === "working" || !!pane.odinQueued),
			);
			const now = new Date();
			const inWindow = inOffHours(now, offHours.start, offHours.end);
			const span = `${offHours.start}-${offHours.end}`;
			if (inWindow) {
				const last = nightLastTick ? new Date(nightLastTick) : null;
				if (last && now.getTime() - last.getTime() > GAP_MS)
					logNight(
						`No ticks from ${last.toLocaleString()} to ${now.toLocaleString()}: Odin was shut or the computer was asleep (lid closed or on battery).`,
					);
				setNightLastTick(now.toISOString());
			}
			if (!offHours.enabled) {
				if (inWindow)
					logNight(`Off in Settings, so the ${span} window starts nothing.`);
				return keepAwake(false);
			}
			// Power only: on battery it starts nothing and lets the computer sleep.
			const onBattery = await electronTrpcClient.device.onBattery
				.query()
				.catch(() => false);
			keepAwake(!onBattery && (inWindow || !!busy));
			if (!inWindow) {
				if (night.current || offHoursStarted)
					logNight(
						`Window ${span} closed: ${offHoursStarted} of at most ${offHours.maxSessions} started.`,
					);
				if (offHoursStarted) setOffHoursStarted(0);
				if (offHoursFromPicks) setOffHoursFromPicks(false);
				tried.current.clear();
				night.current = null;
				return;
			}
			if (onBattery)
				return logNight("On battery: starting nothing until on power.");
			if (offHoursStarted >= offHours.maxSessions)
				return logNight(
					`Reached tonight's cap of ${offHours.maxSessions} sessions.`,
				);
			if (busy)
				return logNight(
					`Waiting for "${busy.odinTaskTitle ?? busy.name}" to stop working.`,
				);
			running = true;
			try {
				const { waiting, rankInput, prompt, start, duplicateFor } =
					latest.current;
				if (offHours.picked.length) {
					// Picks are yours, so the ranking and its hides don't apply to them.
					const byKey = new Map(waiting.map((row) => [row.key, row]));
					// A pick the feed no longer lists is dropped, so it can't hold a cap slot.
					if (waiting.length && offHours.picked.some((key) => !byKey.has(key)))
						setOffHours({
							picked: offHours.picked.filter((key) => byKey.has(key)),
						});
					const item = offHours.picked
						.map((key) => byKey.get(key))
						.find(
							(row) => row && !tried.current.has(row.key) && !duplicateFor(row),
						);
					if (item) {
						tried.current.add(item.key);
						logNight(`Started your pick "${item.title}" (${item.source}).`);
						setOffHours({
							picked: offHours.picked.filter((key) => key !== item.key),
						});
						setOffHoursFromPicks(true);
						setOffHoursStarted(offHoursStarted + 1);
						await start(item, { instructions: offHours.instructions });
						return;
					}
				}
				// A night with picks runs only picks, unless you said to go on after them.
				if (
					(offHours.picked.length || offHoursFromPicks) &&
					offHours.afterPicks === "stop"
				)
					return logNight(
						'Picks all started, and "after picks" is set to stop: starting nothing more.',
					);
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
					const ruledOut = waiting
						.filter((row) => ranking.hidden.includes(row.key))
						.map((row) => `"${row.title}"`);
					logNight(
						`Ranked ${waiting.length} waiting rows; your instructions ruled out ${ruledOut.length}${ruledOut.length ? `: ${ruledOut.join(", ")}` : ""}.`,
					);
				}
				const { order, hidden } = night.current as NightRanking;
				const { pinned, unpinned } = latest.current;
				const rank = (key: string) => order.get(key) ?? order.size;
				const item = [
					...pinned,
					...unpinned.toSorted((a, b) => rank(a.key) - rank(b.key)),
				].find(
					(row) =>
						!hidden.has(row.key) &&
						!tried.current.has(row.key) &&
						!duplicateFor(row),
				);
				if (!item)
					return logNight(
						`Nothing left to start: ${waiting.length} waiting, ${hidden.size} ruled out, ${tried.current.size} already tried, the rest marked duplicates.`,
					);
				tried.current.add(item.key);
				logNight(
					`Started "${item.title}" (${item.source}), top of the ranking.`,
				);
				setOffHoursStarted(offHoursStarted + 1);
				await start(item, { instructions: offHours.instructions });
			} catch (error) {
				logNight(
					`Ranking failed, so it started nothing: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				running = false;
			}
		};
		const id = setInterval(() => void tick(), TICK_MS);
		// Remote mode: the server's Night Agent works from the queue as this
		// window last built it.
		const push = setInterval(() => {
			if (!isRemoteCoreMode()) return;
			mirrorJson(NIGHT_QUEUE_KEY, nightQueueOf(latest.current)).catch((error) =>
				console.warn("[night] queue push failed:", error),
			);
		}, QUEUE_PUSH_MS);
		return () => {
			clearInterval(id);
			clearInterval(push);
			keepAwake(false);
		};
	}, []);
}
