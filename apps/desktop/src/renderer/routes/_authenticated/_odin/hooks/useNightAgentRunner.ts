import { useEffect, useRef } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	inOffHours,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useNextInLineQueue } from "../board/NextInLine";

const TICK_MS = 60_000;
/** Ticks this far apart mean the runner wasn't running in between. */
const GAP_MS = 5 * TICK_MS;

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

/**
 * Tonight's window as epoch seconds: the one we're in, or the next one. The
 * host runs on its own clock and timezone, so it gets absolute times.
 */
export function nightWindow(
	now: Date,
	start: string,
	end: string,
): { from: number; to: number } {
	const at = (day: Date, hhmm: string) => {
		const [h, m] = hhmm.split(":").map(Number);
		const d = new Date(day);
		d.setHours(h ?? 0, m ?? 0, 0, 0);
		return d;
	};
	const dayMs = 86_400_000;
	for (const offset of [-1, 0, 1]) {
		const from = at(new Date(now.getTime() + offset * dayMs), start);
		let to = at(from, end);
		if (to <= from) to = new Date(to.getTime() + dayMs);
		if (now < to)
			return {
				from: Math.floor(from.getTime() / 1000),
				to: Math.floor(to.getTime() / 1000),
			};
	}
	throw new Error("no window");
}

/** Plans re-sent this often while the laptop is awake, so the host's tokens stay fresh. */
const RESEND_MS = 30 * 60_000;
/** How often the board checks what the host started. */
const ADOPT_EVERY_TICKS = 5;

/** Your sort words plus the Night Agent ones - what the night ranking obeys. */
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
 * Move it to main the day it has to run with the window shut.
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
	// The last plan sent to the remote host, and when.
	const sent = useRef<{ signature: string; at: number } | null>(null);

	useEffect(() => {
		let running = false;
		let ticks = 0;
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
		/** The night's order: your picks, then the ranking (asked when stale). */
		const tonight = async (instructions: string) => {
			const { offHours, setOffHours, logNight } =
				useNextInLinePrompt.getState();
			const { waiting, rankInput, duplicateFor, pinned, unpinned } =
				latest.current;
			const byKey = new Map(waiting.map((row) => [row.key, row]));
			const picks = offHours.picked
				.map((key) => byKey.get(key))
				.filter((row) => row !== undefined);
			if (waiting.length && picks.length < offHours.picked.length)
				setOffHours({ picked: picks.map((row) => row.key) });
			if (picks.length && offHours.afterPicks === "stop") return picks;
			const stale =
				night.current?.instructions !== instructions ||
				waiting.some((row) => !night.current?.seen.has(row.key));
			if (stale) {
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
				logNight(
					`Ranked ${waiting.length} waiting rows for the remote host; your instructions ruled out ${ranking.hidden.length}.`,
				);
			}
			const { order, hidden } = night.current as NightRanking;
			const rank = (key: string) => order.get(key) ?? order.size;
			const rest = [
				...pinned,
				...unpinned.toSorted((a, b) => rank(a.key) - rank(b.key)),
			].filter((row) => !hidden.has(row.key) && !duplicateFor(row));
			return [...picks, ...rest.filter((row) => !picks.includes(row))];
		};

		/** Remote host mode: send the plan when it changed, adopt what the host started. */
		const runOnHost = async (name: string, now: Date, span: string) => {
			const { offHours, logNight } = useNextInLinePrompt.getState();
			if (ticks++ % ADOPT_EVERY_TICKS === 0) {
				const started =
					await electronTrpcClient.remoteHost.nightStarted.query();
				const panes = Object.values(useTabsStore.getState().panes);
				for (const run of started) {
					if (panes.some((pane) => pane.claudeSessionId === run.sessionId))
						continue;
					const item = latest.current.waiting.find(
						(row) => row.key === run.key,
					);
					if (!item) continue;
					await latest.current.start(item, {
						instructions: offHours.instructions,
						hostSession: run.sessionId,
					});
					logNight(
						`"${run.title}" ran on ${name} overnight - it's on the board now.`,
					);
				}
			}
			const window = nightWindow(now, offHours.start, offHours.end);
			const instructions = nightInstructions(
				latest.current.prompt,
				offHours.instructions,
			);
			// A few past the cap, so a task that fails to start still leaves a night's worth.
			const order = (await tonight(instructions)).slice(
				0,
				offHours.maxSessions + 3,
			);
			const signature = JSON.stringify([
				window,
				offHours.maxSessions,
				offHours.instructions,
				order.map((row) => row.key),
			]);
			if (
				sent.current?.signature === signature &&
				Date.now() - sent.current.at < RESEND_MS
			)
				return;
			const tasks = [];
			for (const item of order) {
				const plan = await latest.current.planOnHost(
					item,
					offHours.instructions,
				);
				tasks.push({
					key: item.key,
					title: item.title,
					sessionId: plan.sessionId,
					repoPath: plan.repoPath,
					prompt: plan.prompt,
				});
			}
			await electronTrpcClient.remoteHost.nightPush.mutate({
				...window,
				cap: offHours.maxSessions,
				tasks,
			});
			if (sent.current?.signature !== signature)
				logNight(
					`Sent ${name} tonight's plan: ${tasks.length} tasks in order, at most ${offHours.maxSessions}, ${span}. It runs there with this computer closed.`,
				);
			sent.current = { signature, at: Date.now() };
		};

		const tick = async () => {
			if (running) return;
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
			// With the remote host on, the night runs there - lid closed or not.
			// This computer only keeps the host's plan current and puts what the
			// host started on the board; it starts nothing itself.
			const host = (
				await electronTrpcClient.remoteHost.get.query().catch(() => null)
			)?.host;
			if (host?.on) {
				keepAwake(false);
				if (running) return;
				running = true;
				try {
					await runOnHost(host.name || host.instanceId, now, span);
				} catch (error) {
					logNight(
						`Tonight's plan for ${host.name || host.instanceId} failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				} finally {
					running = false;
				}
				return;
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
		return () => {
			clearInterval(id);
			keepAwake(false);
		};
	}, []);
}
