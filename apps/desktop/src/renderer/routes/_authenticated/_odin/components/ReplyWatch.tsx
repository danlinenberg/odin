import { cn } from "@odin/ui/utils";
import type { ThreadActivity } from "lib/trpc/routers/work";
import { useEffect } from "react";
import { LuBell, LuBellRing } from "react-icons/lu";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { IconTip } from "./FeedChrome";

/** A thread you asked to hear about. */
export interface Watch {
	title: string;
	url: string | null;
	/** The newest reply seen so far ("" = none yet). Unset until the first check. */
	stamp?: string;
}

/**
 * "Ping me on replies": the rows whose thread you want a banner for whenever
 * someone answers in it, keyed like the task rows. Bounded by hand - a watch
 * only exists because you clicked the bell, and clicking it again drops it.
 */
export const useReplyWatch = create<{
	watches: Record<string, Watch>;
	toggle: (key: string, title: string, url: string | null) => void;
	setStamps: (stamps: Record<string, string>) => void;
}>()(
	persist(
		(set) => ({
			watches: {},
			toggle: (key, title, url) =>
				set((s) => {
					const { [key]: on, ...rest } = s.watches;
					return { watches: on ? rest : { ...rest, [key]: { title, url } } };
				}),
			setStamps: (stamps) =>
				set((s) => ({
					watches: Object.fromEntries(
						Object.entries(s.watches).map(([key, watch]) => [
							key,
							key in stamps ? { ...watch, stamp: stamps[key] } : watch,
						]),
					),
				})),
		}),
		{ name: "odin-reply-watch" },
	),
);

/** Only Slack threads and Jira tickets have replies Odin can read. */
export function canWatch(key: string): boolean {
	return key.startsWith("slack:") || key.startsWith("jira:");
}

/**
 * The watches with a new reply from someone else. A watch's first check only
 * records where the thread stands: the replies already there are why you
 * watched it, not news.
 */
export function newReplies(
	watches: Record<string, Watch>,
	activity: Record<string, ThreadActivity>,
): string[] {
	return Object.keys(activity).filter((key) => {
		const seen = watches[key]?.stamp;
		const now = activity[key];
		return seen !== undefined && !!now && now.stamp !== seen && !now.byMe;
	});
}

/**
 * Check every watched thread on launch and every five minutes after, and ping
 * for each one someone replied in. Mounted in the shell, so it runs whatever
 * screen is open.
 *
 * ponytail: one 5-minute poll, sequential Slack lookups (Slack's own gate
 * throttles them). Fine for a handful of watches; batch if it grows to dozens.
 */
export function useReplyWatcher(): void {
	useEffect(() => {
		const tick = async () => {
			const { watches, setStamps } = useReplyWatch.getState();
			const keys = Object.keys(watches);
			if (!keys.length) return;
			const after = (prefix: string) =>
				keys
					.filter((k) => k.startsWith(prefix))
					.map((k) => k.slice(prefix.length));
			const activity = await electronTrpcClient.work.threadActivity
				.query({ slack: after("slack:"), jira: after("jira:") })
				.catch(() => ({}) as Record<string, ThreadActivity>);
			for (const key of newReplies(watches, activity)) {
				const watch = watches[key];
				const note = new Notification(`New reply: ${watch?.title ?? key}`, {
					body: activity[key]?.text ?? "Someone replied in the thread.",
				});
				note.onclick = () => {
					if (watch?.url)
						void electronTrpcClient.external.openUrl.mutate(watch.url);
					else window.focus();
				};
			}
			setStamps(
				Object.fromEntries(
					Object.entries(activity).map(([key, a]) => [key, a.stamp]),
				),
			);
		};
		void tick();
		const id = setInterval(() => void tick(), 5 * 60_000);
		return () => clearInterval(id);
	}, []);
}

/** The bell on a task row: ping me when someone replies in this thread. */
export function WatchButton({
	itemKey,
	title,
	url,
	className,
}: {
	itemKey: string;
	title: string;
	url: string | null;
	className?: string;
}) {
	const on = useReplyWatch((s) => !!s.watches[itemKey]);
	const toggle = useReplyWatch((s) => s.toggle);
	const label = on ? "Stop pinging me on replies" : "Ping me on replies";
	return (
		<IconTip label={label}>
			<button
				type="button"
				aria-label={label}
				aria-pressed={on}
				onClick={(e) => {
					e.stopPropagation();
					toggle(itemKey, title, url);
				}}
				className={cn(className, on && "text-primary")}
			>
				{on ? (
					<LuBellRing className="size-3.5" aria-hidden />
				) : (
					<LuBell className="size-3.5" aria-hidden />
				)}
			</button>
		</IconTip>
	);
}
