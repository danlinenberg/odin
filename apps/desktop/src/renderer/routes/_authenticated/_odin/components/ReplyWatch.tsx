import { cn } from "@odin/ui/utils";
import type { ThreadActivity } from "lib/trpc/routers/work";
import { useEffect, useRef } from "react";
import { LuBellRing } from "react-icons/lu";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PILL } from "./pill";

/** A thread you asked to hear about, and the session it belongs to. */
export interface Watch {
	title: string;
	/** The session to open when someone replies. */
	paneId?: string;
	/** The newest reply seen so far ("" = none yet). Unset until the first check. */
	stamp?: string;
	/** A reply from someone else you haven't opened the session for yet. */
	reply?: string;
	/** The thread itself, for Open once the session is closed. */
	url?: string;
}

/**
 * "Ping me": the sessions whose Slack thread or Jira ticket you want a banner
 * for whenever someone answers in it, or whose PR you want one for once it's
 * approved. Keyed by what's watched (`slack:<channel>:<ts>`, `jira:<KEY>`,
 * `pr:<url>`); one session can hold a thread and a PR. Bounded by hand - a
 * watch only exists because you turned it on in the session's menu.
 */
export const useReplyWatch = create<{
	watches: Record<string, Watch>;
	/** Watch all of `keys` for the session, or stop every watch it has. */
	toggle: (keys: string[], title: string, paneId: string) => void;
	setStamps: (
		stamps: Record<string, string>,
		replies?: Record<string, string>,
		urls?: Record<string, string | null>,
	) => void;
	/** The session was opened: its reply is read. */
	seen: (paneId: string) => void;
}>()(
	persist(
		(set) => ({
			watches: {},
			toggle: (keys, title, paneId) =>
				set((s) => {
					const rest = Object.fromEntries(
						Object.entries(s.watches).filter(([, w]) => w.paneId !== paneId),
					);
					const on = Object.keys(rest).length < Object.keys(s.watches).length;
					return {
						watches: on
							? rest
							: {
									...rest,
									...Object.fromEntries(
										keys.map((k) => [k, { title, paneId }]),
									),
								},
					};
				}),
			setStamps: (stamps, replies = {}, urls = {}) =>
				set((s) => ({
					watches: Object.fromEntries(
						Object.entries(s.watches).map(([key, watch]) => [
							key,
							key in stamps
								? {
										...watch,
										stamp: stamps[key],
										reply: replies[key] ?? watch.reply,
										url: urls[key] ?? watch.url,
									}
								: watch,
						]),
					),
				})),
			seen: (paneId) =>
				set((s) =>
					Object.values(s.watches).some((w) => w.paneId === paneId && w.reply)
						? {
								watches: Object.fromEntries(
									Object.entries(s.watches).map(([key, watch]) => [
										key,
										watch.paneId === paneId
											? { ...watch, reply: undefined }
											: watch,
									]),
								),
							}
						: s,
				),
		}),
		{ name: "odin-reply-watch" },
	),
);

const SLACK_LINK =
	/slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\S*?[?&]thread_ts=(\d+\.\d+))?/;
const SLACK_ID = /^[A-Z0-9]+:\d+\.\d+$/;
/** A browse link anywhere, or a title that opens with the key - "ABC-12: Fix x". */
const JIRA_KEY = /\/browse\/([A-Z][A-Z0-9_]+-\d+)|^([A-Z][A-Z0-9_]+-\d+):/m;

/**
 * The thread a session is about, as a watch key: the Slack message it was
 * started from, else the first Slack link or Jira ticket in its title, brief
 * or the links the session panel shows. A link to a reply watches the thread
 * it sits in. Null when it has none - the menu then has nothing to offer.
 */
export function sessionThread(pane: {
	odinPageId?: string;
	odinTaskTitle?: string;
	odinBrief?: string;
	brief?: string;
	links?: (string | null | undefined)[];
}): string | null {
	if (pane.odinPageId && SLACK_ID.test(pane.odinPageId))
		return `slack:${pane.odinPageId}`;
	const text = [
		pane.odinTaskTitle,
		pane.odinBrief,
		pane.brief,
		...(pane.links ?? []),
	]
		.filter(Boolean)
		.join("\n");
	const slack = SLACK_LINK.exec(text);
	if (slack)
		return `slack:${slack[1]}:${slack[4] ?? `${slack[2]}.${slack[3]}`}`;
	const jira = JIRA_KEY.exec(text);
	const key = jira?.[1] ?? jira?.[2];
	return key ? `jira:${key}` : null;
}

/** What a watch's ping says happened: a PR gets approved, a thread gets a reply. */
export function watchEvent(key: string): string {
	return key.startsWith("pr:") ? "Approved" : "New reply";
}

/**
 * The watches with a new reply from someone else. A thread's first check only
 * records where it stands: the replies already there are why you watched it,
 * not news. A PR already approved by its first check is news - approval is
 * what you asked to hear about.
 */
export function newReplies(
	watches: Record<string, Watch>,
	activity: Record<string, ThreadActivity>,
): string[] {
	return Object.keys(activity).filter((key) => {
		const seen = watches[key]?.stamp;
		const now = activity[key];
		const first = seen === undefined;
		return (
			!!now &&
			!now.byMe &&
			now.stamp !== seen &&
			(!first || key.startsWith("pr:"))
		);
	});
}

/**
 * Check every watched session's thread on launch and every minute after, and ping
 * for each one someone replied in. Mounted in the shell, so it runs whatever
 * screen is open.
 *
 * ponytail: one 1-minute poll, sequential Slack lookups (Slack's own gate
 * throttles them). Fine for a handful of watches; batch if it grows to dozens.
 */
export function useReplyWatcher(openSession: (paneId: string) => void): void {
	const open = useRef(openSession);
	open.current = openSession;
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
				.query({
					slack: after("slack:"),
					jira: after("jira:"),
					prs: after("pr:"),
				})
				.catch(() => ({}) as Record<string, ThreadActivity>);
			const replies: Record<string, string> = {};
			for (const key of newReplies(watches, activity)) {
				const watch = watches[key];
				replies[key] = activity[key]?.text ?? "Someone replied in the thread.";
				const note = new Notification(
					`${watchEvent(key)}: ${watch?.title ?? key}`,
					{
						body: replies[key],
					},
				);
				note.onclick = () => {
					window.focus();
					if (watch?.paneId) open.current(watch.paneId);
				};
			}
			setStamps(
				Object.fromEntries(
					Object.entries(activity).map(([key, a]) => [key, a.stamp]),
				),
				replies,
				Object.fromEntries(
					Object.entries(activity).map(([key, a]) => [key, a.url]),
				),
			);
		};
		void tick();
		const id = setInterval(() => void tick(), 60_000);
		return () => clearInterval(id);
	}, []);
}

/** Whether anything of this session's is watched. */
function useWatched(paneId: string): boolean {
	return useReplyWatch((s) =>
		Object.values(s.watches).some((w) => w.paneId === paneId),
	);
}

/** The bell a watched session wears beside its title, like ★ on a starred one. */
export function WatchMark({ paneId }: { paneId: string }) {
	if (!useWatched(paneId)) return null;
	return (
		<LuBellRing
			title="Pinging you - right-click to stop"
			className="mr-1 inline size-3.5 align-[-2px] text-primary"
		/>
	);
}

/**
 * The unread reply on a watched session's card, so a missed ping still shows.
 * Opening the session clears it.
 */
export function WatchReply({ paneId }: { paneId: string }) {
	const key = useReplyWatch((s) =>
		Object.keys(s.watches).find(
			(k) => s.watches[k]?.paneId === paneId && s.watches[k]?.reply,
		),
	);
	const reply = useReplyWatch((s) => (key ? s.watches[key]?.reply : undefined));
	if (!key || !reply) return null;
	return (
		<div
			title={reply}
			className="mt-1 truncate text-[11.5px] font-medium text-attention"
		>
			<LuBellRing className="mr-1 inline size-3 align-[-2px]" aria-hidden />
			{watchEvent(key)}: {reply}
		</div>
	);
}

/** The drawer's pill for a watched session; clicking it stops the pings. */
export function WatchPill({ paneId }: { paneId: string }) {
	const watched = useWatched(paneId);
	const toggle = useReplyWatch((s) => s.toggle);
	const seen = useReplyWatch((s) => s.seen);
	// The drawer shows this session, so its reply is read.
	useEffect(() => seen(paneId), [seen, paneId]);
	if (!watched) return null;
	return (
		<button
			type="button"
			title="Odin pings you when someone else replies in this session's thread, or its PR is approved. Click to stop."
			onClick={() => toggle([], "", paneId)}
			className={cn(
				"flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium",
				PILL.brand,
			)}
		>
			<LuBellRing className="size-3" aria-hidden />
			Pinging you
		</button>
	);
}
