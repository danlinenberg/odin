import { useEffect, useRef } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import { useTabsStore } from "renderer/stores/tabs/store";
import { AWAY_TASKS } from "shared/away-tasks";
import { useNextInLineQueue } from "../board/NextInLine";

const TICK_MS = 60_000;
/** Sent again this often while the Mac is awake, so the host's tokens stay fresh. */
const RESEND_MS = 30 * 60_000;
/** How often the board checks what the phone started there. */
const ADOPT_EVERY_TICKS = 5;
/** A phone start older than the list's reach isn't put on the board. */
const ADOPT_DAYS = 4;

/** A run the board should adopt: the phone's, not on the board, not adopted before. */
export function adoptable(
	run: { away?: boolean; sessionId: string; at: number },
	onBoard: Set<string>,
	now = Date.now(),
): boolean {
	return (
		!!run.away &&
		run.at >= now / 1000 - ADOPT_DAYS * 86_400 &&
		!onBoard.has(run.sessionId)
	);
}

/**
 * Tasks with the Mac closed (Settings > Remote > Phone): while it is on and
 * the remote host is in use, the top of Next in line goes to the host as
 * ready session scripts (main/lib/remote-host/away), so the phone can start
 * one there with this Mac asleep or shut. When the Mac is back, what the
 * phone started there comes onto the board, attached to its host session.
 */
export function useAwayTasksSync() {
	const queue = useNextInLineQueue();
	const latest = useRef(queue);
	latest.current = queue;

	useEffect(() => {
		let running = false;
		let ticks = 0;
		let sent: { signature: string; at: number } | null = null;
		const tick = async () => {
			if (running) return;
			const host = (
				await electronTrpcClient.remoteHost.get.query().catch(() => null)
			)?.host;
			if (!host?.on || !host.awayTasks) {
				sent = null;
				return;
			}
			running = true;
			try {
				const name = host.name || host.instanceId;
				if (ticks++ % ADOPT_EVERY_TICKS === 0) {
					const { started } =
						await electronTrpcClient.remoteHost.nightStarted.query();
					const { nightLog, logNight } = useNextInLinePrompt.getState();
					const onBoard = new Set<string>();
					for (const pane of Object.values(useTabsStore.getState().panes))
						if (pane.claudeSessionId) onBoard.add(pane.claudeSessionId);
					for (const entry of nightLog)
						if (entry.started) onBoard.add(entry.started.sessionId);
					for (const run of started) {
						if (!adoptable(run, onBoard)) continue;
						const item = latest.current.waiting.find(
							(row) => row.key === run.key,
						);
						if (!item) continue;
						const adopted = await latest.current.start(item, {
							instructions: "",
							hostSession: run.sessionId,
						});
						if (!adopted.ok) continue;
						onBoard.add(run.sessionId);
						logNight(
							`"${run.title}" was started on ${name} from your phone - it's on the board now.`,
							{
								started: {
									key: run.key,
									title: run.title,
									source: item.source,
									sessionId: run.sessionId,
								},
								at: new Date(run.at * 1000).toISOString(),
							},
						);
					}
				}
				const { pinned, unpinned, duplicateFor, planOnHost } = latest.current;
				const order = [...pinned, ...unpinned]
					.filter((row) => !duplicateFor(row))
					.slice(0, AWAY_TASKS);
				const signature = JSON.stringify(order.map((row) => row.key));
				if (sent?.signature === signature && Date.now() - sent.at < RESEND_MS)
					return;
				const tasks = [];
				for (const item of order) {
					const plan = await planOnHost(item, "");
					tasks.push({
						key: item.key,
						title: item.title,
						sessionId: plan.sessionId,
						repoPath: plan.repoPath,
						prompt: plan.prompt,
					});
				}
				await electronTrpcClient.remoteHost.awayPush.mutate({ tasks });
				sent = { signature, at: Date.now() };
			} catch (error) {
				console.warn("[away-tasks]", error);
			} finally {
				running = false;
			}
		};
		void tick();
		const id = setInterval(() => void tick(), TICK_MS);
		return () => clearInterval(id);
	}, []);
}
