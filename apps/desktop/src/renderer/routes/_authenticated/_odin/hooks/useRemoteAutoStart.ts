import { toast } from "@odin/ui/sonner";
import { useEffect, useRef } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { AUTO_START_SOURCES } from "shared/auto-start";
import type { AllItem } from "../all/all-items";
import { useNextInLineQueue } from "../board/NextInLine";

/** How often the waiting rows are handed to the main process. */
const LOOK_EVERY_MS = 30_000;

const SOURCES = new Set<string>(AUTO_START_SOURCES);

/**
 * Settings > Remote > Auto-start new tasks: while the remote host is on,
 * start a session there on every new task from a source switched on. The
 * main process decides what is new (claimNewTasks) and hands each row out
 * once; a row is then started as if you clicked Start, on the host, without
 * asking for context or pulling the board into view. Mounted in the Odin
 * shell so it runs whichever view is open.
 */
export function useRemoteAutoStart(): void {
	const queue = useNextInLineQueue(true);
	// The interval reads the latest rows and start without restarting.
	const latest = useRef(queue);
	latest.current = queue;

	useEffect(() => {
		let busy = false;
		const look = async () => {
			if (busy) return;
			busy = true;
			try {
				const { waiting } = latest.current;
				const rows = waiting.filter((item) => SOURCES.has(item.source));
				// A look on no rows at all is a feed still loading: nothing to learn.
				if (rows.length === 0) return;
				const keys = await electronTrpcClient.remoteHost.claimNewTasks.mutate({
					rows: rows.map((item) => ({ source: item.source, key: item.key })),
				});
				for (const key of keys) {
					const item = latest.current.waiting.find((row) => row.key === key);
					// One failed start must not cost the rows claimed after it.
					if (item) await startOne(item).catch(() => {});
				}
			} catch {
				// The next look tries again; a claimed row is not handed out twice.
			} finally {
				busy = false;
			}
		};
		const startOne = async (item: AllItem) => {
			const { start, livePaneFor, duplicateFor } = latest.current;
			if (livePaneFor(item)) return;
			if (duplicateFor(item)) return;
			// The Slack launch reaction starts its rows too: one claim for both.
			if (item.source === "Slack") {
				const { claimed } = await electronTrpcClient.slack.claimLaunch.mutate({
					id: item.launch.key,
				});
				if (!claimed) return;
			}
			const result = await start(item, undefined, {
				guidelines: "",
				images: [],
				onHost: true,
				// A Slack reaction is the ask, as with the launch reaction.
				...(item.source === "Slack" ? { tags: ["auto-started"] } : {}),
			});
			if (result.ok)
				toast.success(`Auto-started from ${item.source}: ${item.title}`);
		};
		const timer = setInterval(() => void look(), LOOK_EVERY_MS);
		return () => clearInterval(timer);
	}, []);
}
