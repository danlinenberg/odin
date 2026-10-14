import type { ThreadActivity } from "lib/trpc/routers/work";
import { useEffect, useRef } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A thread you asked to hear about, and the session it belongs to. */
export interface Watch {
	title: string;
	/** The session to open when someone replies. */
	paneId?: string;
	/** The newest reply seen so far ("" = none yet). Unset until the first check. */
	stamp?: string;
}

/**
 * "Ping me on replies": the sessions whose Slack thread or Jira ticket you
 * want a banner for whenever someone answers in it, keyed by the thread
 * (`slack:<channel>:<ts>`, `jira:<KEY>`). Bounded by hand - a watch only
 * exists because you turned it on in the session's menu.
 */
export const useReplyWatch = create<{
	watches: Record<string, Watch>;
	toggle: (key: string, title: string, paneId: string) => void;
	setStamps: (stamps: Record<string, string>) => void;
}>()(
	persist(
		(set) => ({
			watches: {},
			toggle: (key, title, paneId) =>
				set((s) => {
					const { [key]: on, ...rest } = s.watches;
					return {
						watches: on ? rest : { ...rest, [key]: { title, paneId } },
					};
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

const SLACK_LINK = /slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/;
const SLACK_ID = /^[A-Z0-9]+:\d+\.\d+$/;
/** A browse link anywhere, or a title that opens with the key - "ABC-12: Fix x". */
const JIRA_KEY = /\/browse\/([A-Z][A-Z0-9_]+-\d+)|^([A-Z][A-Z0-9_]+-\d+):/m;

/**
 * The thread a session is about, as a watch key: the Slack message it was
 * started from, else the first Slack link or Jira ticket in its title or
 * brief. Null when it has none - the menu then has nothing to offer.
 */
export function sessionThread(pane: {
	odinPageId?: string;
	odinTaskTitle?: string;
	odinBrief?: string;
	brief?: string;
}): string | null {
	if (pane.odinPageId && SLACK_ID.test(pane.odinPageId))
		return `slack:${pane.odinPageId}`;
	const text = [pane.odinTaskTitle, pane.odinBrief, pane.brief]
		.filter(Boolean)
		.join("\n");
	const slack = SLACK_LINK.exec(text);
	if (slack) return `slack:${slack[1]}:${slack[2]}.${slack[3]}`;
	const jira = JIRA_KEY.exec(text);
	const key = jira?.[1] ?? jira?.[2];
	return key ? `jira:${key}` : null;
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
 * Check every watched session's thread on launch and every five minutes after, and ping
 * for each one someone replied in. Mounted in the shell, so it runs whatever
 * screen is open.
 *
 * ponytail: one 5-minute poll, sequential Slack lookups (Slack's own gate
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
				.query({ slack: after("slack:"), jira: after("jira:") })
				.catch(() => ({}) as Record<string, ThreadActivity>);
			for (const key of newReplies(watches, activity)) {
				const watch = watches[key];
				const note = new Notification(`New reply: ${watch?.title ?? key}`, {
					body: activity[key]?.text ?? "Someone replied in the thread.",
				});
				note.onclick = () => {
					window.focus();
					if (watch?.paneId) open.current(watch.paneId);
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
