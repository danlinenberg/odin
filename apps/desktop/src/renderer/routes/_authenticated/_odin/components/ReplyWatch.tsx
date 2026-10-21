import { cn } from "@odin/ui/utils";
import type { ThreadActivity } from "lib/trpc/routers/work";
import type { TranscriptMessage } from "main/lib/claude-sessions/claude-sessions";
import { useEffect, useRef } from "react";
import { LuBellRing } from "react-icons/lu";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { PaneStatus } from "shared/tabs-types";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { PILL } from "./pill";

/** A thread you asked to hear about, and the session it belongs to. */
export interface Watch {
	title: string;
	/** The session to open when someone replies. */
	paneId?: string;
	/** The newest reply seen so far ("" = none yet). Unset until the first check. */
	stamp?: string;
	/** A reply from someone else you haven't written in the session since. */
	reply?: string;
	/** The thread itself, for Open once the session is closed. */
	url?: string;
	/** "Ping me when...": what the session's Claude watches for. */
	condition?: string;
	/** When the condition watch started (ms): older lines don't count. */
	since?: number;
	/** What a fired condition watch says happened. */
	event?: ConditionEvent;
}

export type ConditionEvent = "Happened" | "Gave up";

/** Watch keys for "Ping me when...": `when:<paneId>:<since>`. */
export const WHEN = "when:";
/** The stamp of a condition watch that fired: it is not checked again. */
const FIRED = "fired";

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
	/** A watched session found more to watch - a draft it left since. */
	add: (keys: string[], paneId: string) => void;
	setStamps: (
		stamps: Record<string, string>,
		replies?: Record<string, string>,
		urls?: Record<string, string | null>,
	) => void;
	/** "Ping me when...": the session's Claude watches for `condition`. */
	watchFor: (condition: string, title: string, paneId: string) => void;
	/** Claude said the condition happened, or gave up on it. */
	fire: (key: string, event: ConditionEvent) => void;
	/** You wrote in the session: its reply is answered. */
	seen: (paneId: string) => void;
	/** The ✕ on one ping: only that ping is read. */
	dismiss: (key: string) => void;
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
			add: (keys, paneId) =>
				set((s) => {
					const title = Object.values(s.watches).find(
						(w) => w.paneId === paneId,
					)?.title;
					const fresh = keys.filter((k) => !s.watches[k]);
					if (title === undefined || !fresh.length) return s;
					return {
						watches: {
							...s.watches,
							...Object.fromEntries(fresh.map((k) => [k, { title, paneId }])),
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
			watchFor: (condition, title, paneId) =>
				set((s) => {
					const since = Date.now();
					return {
						watches: {
							...s.watches,
							[`${WHEN}${paneId}:${since}`]: {
								title,
								paneId,
								condition,
								since,
							},
						},
					};
				}),
			fire: (key, event) =>
				set((s) => {
					const watch = s.watches[key];
					if (!watch) return s;
					return {
						watches: {
							...s.watches,
							[key]: {
								...watch,
								stamp: FIRED,
								event,
								reply: watch.condition ?? watch.title,
							},
						},
					};
				}),
			// A condition watch that fired is done once you've read it.
			seen: (paneId) =>
				set((s) =>
					Object.values(s.watches).some((w) => w.paneId === paneId && w.reply)
						? {
								watches: Object.fromEntries(
									Object.entries(s.watches).flatMap(([key, watch]) =>
										watch.paneId !== paneId
											? [[key, watch]]
											: watch.stamp === FIRED && key.startsWith(WHEN)
												? []
												: [[key, { ...watch, reply: undefined }]],
									),
								),
							}
						: s,
				),
			dismiss: (key) =>
				set((s) => {
					const watch = s.watches[key];
					if (!watch?.reply) return s;
					const { [key]: _, ...rest } = s.watches;
					// Like seen: a condition watch that fired is done once read.
					return {
						watches:
							watch.stamp === FIRED && key.startsWith(WHEN)
								? rest
								: { ...s.watches, [key]: { ...watch, reply: undefined } },
					};
				}),
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

/**
 * What a watch's ping says happened: a PR gets approved, a thread gets a
 * reply, a condition happens (or Claude gave up watching for it).
 */
export function watchEvent(key: string, watch?: Watch): string {
	if (key.startsWith(WHEN)) return watch?.event ?? "Happened";
	return key.startsWith("pr:") ? "Approved" : "New reply";
}

/**
 * What Odin types into the session for "Ping me when...". Claude checks the
 * condition with its own tools and skills - Odin has no connector for a
 * Datadog log, a deploy or an edit job - and ends with one line Odin reads.
 */
export function conditionPrompt(condition: string): string {
	return [
		`Ping me when: ${condition}`,
		"Watch for this yourself, with your tools and skills. Check it now, then again at a sensible interval for what it is (a few minutes apart is usually right; /loop works), for up to 4 hours. Don't ask me anything while you watch.",
		"When it happens, reply with this line on its own and stop: ODIN PING: HAPPENED - <one short line on what you saw>",
		"If you hit the 4 hours, or can't check it at all, reply with this line on its own and stop: ODIN PING: GAVE UP - <why>",
	].join("\n");
}

const PING_LINE =
	/^[\s>*_`]*ODIN PING:\s*(HAPPENED|GAVE UP)\b[\s*_`]*-?\s*(.*)$/gim;

/**
 * The line Claude ends a condition watch with, in a reply after `since`.
 * Only Claude's own lines count, and only ones that start with it: the prompt
 * quotes it, and a reply can promise it ("I'll reply `ODIN PING: ...`").
 * A placeholder left in (`<what I saw>`) is the template, not news.
 */
export function conditionOutcome(
	messages: Pick<TranscriptMessage, "role" | "text" | "at">[],
	since: number,
): { event: ConditionEvent; detail: string } | null {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (!message.at || Date.parse(message.at) < since) continue;
		for (const [, word = "", rest = ""] of message.text.matchAll(PING_LINE)) {
			const detail = rest.replace(/[*_`]+$/, "").trim();
			if (detail.startsWith("<")) continue;
			return {
				event: word.toUpperCase() === "HAPPENED" ? "Happened" : "Gave up",
				detail,
			};
		}
	}
	return null;
}

/**
 * The pings you haven't answered, as the board's Reminders bar lists them:
 * a reply or approval on a watch that still knows its session.
 */
export function unreadPings(
	watches: Record<string, Watch>,
): (Omit<Watch, "event"> & { key: string; event: string })[] {
	return Object.entries(watches)
		.filter(([, w]) => w.reply && w.paneId)
		.map(([key, w]) => ({ ...w, key, event: watchEvent(key, w) }));
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
 */
export function useReplyWatcher(openSession: (paneId: string) => void): void {
	const open = useRef(openSession);
	open.current = openSession;
	useEffect(() => {
		const tick = async () => {
			void checkConditions((paneId) => open.current(paneId));
			const { watches, setStamps } = useReplyWatch.getState();
			const keys = Object.keys(watches).filter((k) => !k.startsWith(WHEN));
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
				replies[key] =
					activity[key]?.text ??
					(key.startsWith("pr:")
						? "Your PR was approved."
						: "Someone replied in the thread.");
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
	// A prompt you send turns the session to Working: that answers its reply.
	// A turn that ends may be the one that says the condition happened.
	useEffect(
		() =>
			useTabsStore.subscribe((now, before) => {
				for (const paneId of startedWorking(before.panes, now.panes))
					useReplyWatch.getState().seen(paneId);
				if (stoppedWorking(before.panes, now.panes).length)
					void checkConditions((paneId) => open.current(paneId));
			}),
		[],
	);
}

/**
 * "Ping me when...": read each watching session's conversation for the line
 * its Claude ends the watch with, and ping once it's there.
 */
async function checkConditions(open: (paneId: string) => void) {
	const { watches, fire } = useReplyWatch.getState();
	const pending = Object.entries(watches).filter(
		([key, w]) => key.startsWith(WHEN) && w.stamp !== FIRED && w.paneId,
	);
	for (const [key, watch] of pending) {
		const paneId = watch.paneId ?? "";
		const sessionId =
			useTabsStore.getState().panes[paneId]?.claudeSessionId ??
			usePaneMeta.getState().sessionIdByPane[paneId];
		if (!sessionId) continue;
		const transcript = await electronTrpcClient.terminal.readClaudeTranscript
			.query({ sessionId })
			.catch(() => null);
		const outcome = transcript
			? conditionOutcome(transcript.messages, watch.since ?? 0)
			: null;
		if (!outcome || useReplyWatch.getState().watches[key]?.stamp === FIRED)
			continue;
		fire(key, outcome.event);
		const note = new Notification(
			`${outcome.event}: ${watch.condition ?? watch.title}`,
			{ body: outcome.detail || watch.title },
		);
		note.onclick = () => {
			window.focus();
			open(paneId);
		};
	}
}

/** The panes that just turned to Working - someone sent them a prompt. */
export function startedWorking(
	before: Record<string, { status?: PaneStatus }>,
	now: Record<string, { status?: PaneStatus }>,
): string[] {
	if (before === now) return [];
	return Object.keys(now).filter(
		(id) => now[id]?.status === "working" && before[id]?.status !== "working",
	);
}

/** The panes whose turn just ended. */
function stoppedWorking(
	before: Record<string, { status?: PaneStatus }>,
	now: Record<string, { status?: PaneStatus }>,
): string[] {
	return startedWorking(now, before);
}

/** Whether anything of this session's is watched. */
function useWatched(paneId: string): boolean {
	return useReplyWatch((s) =>
		Object.values(s.watches).some((w) => w.paneId === paneId),
	);
}

/** Whether a reply waits in the session that you haven't written back to. */
function useUnanswered(paneId: string): boolean {
	return useReplyWatch((s) =>
		Object.values(s.watches).some((w) => w.paneId === paneId && w.reply),
	);
}

const JIGGLE =
	"origin-top motion-safe:animate-[bell-jiggle_1.4s_ease-in-out_infinite]";

/**
 * The bell a watched session wears beside its title, like ★ on a starred one.
 * It jiggles while a reply waits and nobody has written in the session since.
 */
export function WatchMark({ paneId }: { paneId: string }) {
	const watched = useWatched(paneId);
	const unanswered = useUnanswered(paneId);
	if (!watched) return null;
	return (
		<LuBellRing
			title={
				unanswered
					? "Someone replied - write in the session to stop the bell"
					: "Pinging you - right-click to stop"
			}
			className={cn(
				"mr-1 inline size-3.5 align-[-2px]",
				unanswered ? cn("text-attention", JIGGLE) : "text-primary",
			)}
		/>
	);
}

/**
 * The unread reply on a watched session's card, so a missed ping still shows.
 * Writing in the session clears it.
 */
export function WatchReply({ paneId }: { paneId: string }) {
	const key = useReplyWatch((s) =>
		Object.keys(s.watches).find(
			(k) => s.watches[k]?.paneId === paneId && s.watches[k]?.reply,
		),
	);
	const reply = useReplyWatch((s) => (key ? s.watches[key]?.reply : undefined));
	const event = useReplyWatch((s) =>
		key ? watchEvent(key, s.watches[key]) : "",
	);
	if (!key || !reply) return null;
	return (
		<div
			title={reply}
			className="mt-1 truncate text-[11.5px] font-medium text-attention"
		>
			<LuBellRing className="mr-1 inline size-3 align-[-2px]" aria-hidden />
			{event}: {reply}
		</div>
	);
}

/** The drawer's pill for a watched session; clicking it stops the pings. */
export function WatchPill({ paneId }: { paneId: string }) {
	const watched = useWatched(paneId);
	const unanswered = useUnanswered(paneId);
	const toggle = useReplyWatch((s) => s.toggle);
	if (!watched) return null;
	return (
		<button
			type="button"
			title="Odin pings you when someone else replies in this session's thread, its PR is approved, or what you asked it to watch for happens. Click to stop."
			onClick={() => toggle([], "", paneId)}
			className={cn(
				"flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium",
				PILL.brand,
			)}
		>
			<LuBellRing className={cn("size-3", unanswered && JIGGLE)} aria-hidden />
			Pinging you
		</button>
	);
}
