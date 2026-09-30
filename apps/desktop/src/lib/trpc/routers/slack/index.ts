import { slackReactions } from "@odin/local-db";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	activeProfileId,
	readOdinConfig,
	resolveSlackToken,
	updateOdinConfig,
} from "../odin-config";
import {
	buildPermalink,
	channelLabel,
	LAUNCH_REACTION,
	mentionedUserIds,
	messageBody,
	normalizeReaction,
	pickEyedMessages,
	QUEUE_REACTION,
	type ReactionStatus,
	reactionStatus,
	replaceMentions,
	rowsToVerify,
	type SlackAttachment,
	type SlackReactionsListItem,
	threadParentTs,
	toTitle,
} from "./reactions";

/**
 * Odin's :eyes: queue — the Slack messages I reacted to, straight from Slack.
 *
 * Runs in the main process: renderer fetches to slack.com would be blocked by
 * CORS, and the token never reaches the renderer. Needs a **user** token
 * (`xoxp-…`, scope `reactions:read`) — a bot token only sees the bot's own
 * reactions. Set it in Settings → Connections.
 *
 * Slack is the source of the feed, not of the state: rows persist locally, so
 * un-reacting marks a row instead of losing it, and Done is Odin-only. Nothing
 * is ever written back to Slack.
 */

const SLACK_API = "https://slack.com/api";

function slackToken(): string | null {
	return resolveSlackToken();
}

/** The reaction Odin watches for — Settings lives in `~/.config/odin.json`. */
function queueReaction(): string {
	return normalizeReaction(readOdinConfig().slackReaction ?? QUEUE_REACTION);
}

function launchReaction(): string {
	return normalizeReaction(
		readOdinConfig().slackLaunchReaction ?? LAUNCH_REACTION,
	);
}

/**
 * Rows whose message carried my launch reaction on the last sync.
 *
 * ponytail: in memory, not a column. The first sync after a restart refills
 * it from Slack, and `startedAt` is what stops a second launch — so nothing
 * here needs to survive a restart.
 */
const launchRequested = new Set<string>();

interface SlackResponse {
	ok?: boolean;
	error?: string;
}

// ponytail: one global gate, 4 Slack calls in flight. A burst past that just
// buys 429s and their Retry-After sleeps.
let slackInFlight = 0;
const slackWaiting: (() => void)[] = [];

async function slackApi<T extends SlackResponse>(
	method: string,
	params: Record<string, string>,
	token: string,
): Promise<T> {
	if (slackInFlight >= 4)
		await new Promise<void>((resolve) => slackWaiting.push(resolve));
	else slackInFlight++;
	try {
		return await slackCall<T>(method, params, token);
	} finally {
		const next = slackWaiting.shift();
		if (next) next();
		else slackInFlight--;
	}
}

/**
 * A read the sweep repeats across rows — the same channel's info, the same
 * thread parent, the same last-read message — asked once per few minutes.
 * Failures aren't kept, so a refused call is asked again next time.
 */
const slackReads = new Map<string, { at: number; value: Promise<unknown> }>();
function slackRead<T extends SlackResponse>(
	method: string,
	params: Record<string, string>,
	token: string,
): Promise<T> {
	const key = `${method}?${new URLSearchParams(params)}`;
	const hit = slackReads.get(key);
	if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value as Promise<T>;
	const value = slackApi<T>(method, params, token);
	slackReads.set(key, { at: Date.now(), value });
	value.catch(() => slackReads.delete(key));
	return value;
}

async function slackCall<T extends SlackResponse>(
	method: string,
	params: Record<string, string>,
	token: string,
): Promise<T> {
	const url = `${SLACK_API}/${method}?${new URLSearchParams(params)}`;
	// A rate limit is "not yet", not an answer: wait what Slack says and ask
	// again. Giving up here is what made each sweep read a different random
	// slice of the backlog as UNKNOWN.
	let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	for (let attempt = 0; res.status === 429 && attempt < 5; attempt++) {
		const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
		await new Promise((resolve) => setTimeout(resolve, wait * 1000));
		res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	}
	const json = (await res.json()) as T;
	if (!json.ok) {
		throw new TRPCError({
			code: json.error === "invalid_auth" ? "UNAUTHORIZED" : "BAD_REQUEST",
			message: `Slack ${method}: ${json.error ?? `HTTP ${res.status}`}`,
		});
	}
	return json;
}

interface Identity {
	userId: string;
	user: string;
	team: string;
	teamUrl: string;
}

// Per-token caches. Cleared when the token changes; a restart clears the rest.
let identityCache: { token: string; identity: Identity } | null = null;
const channelNames = new Map<string, string>();
const userNames = new Map<string, string>();

export function clearSlackCaches(): void {
	identityCache = null;
	channelNames.clear();
	userNames.clear();
}

/**
 * Drop this profile's queue. Signing out of Slack should take the messages
 * that came from it with it — the rows live here, not in Slack, so nothing
 * else would ever remove them. Reconnecting re-syncs the ones still :eyes:'d;
 * what's lost is the started/done marks on the rest, which is the point of
 * disconnecting.
 */
export function clearSlackQueue(): void {
	localDb
		.delete(slackReactions)
		.where(eq(slackReactions.profileId, activeProfileId()))
		.run();
}

async function getIdentity(token: string): Promise<Identity> {
	if (identityCache?.token === token) return identityCache.identity;
	const res = await slackApi<
		SlackResponse & {
			user_id?: string;
			user?: string;
			team?: string;
			url?: string;
		}
	>("auth.test", {}, token);
	if (!res.user_id) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Slack auth.test returned no user — is this a user token?",
		});
	}
	const identity: Identity = {
		userId: res.user_id,
		user: res.user ?? res.user_id,
		team: res.team ?? "",
		teamUrl: res.url ?? "",
	};
	identityCache = { token, identity };
	return identity;
}

/** Best-effort lookups: a missing name is cosmetic, never a sync failure. */
async function lookupChannelName(
	channelId: string,
	token: string,
): Promise<string | null> {
	const cached = channelNames.get(channelId);
	if (cached) return cached;
	try {
		const res = await slackApi<SlackResponse & { channel?: { name?: string } }>(
			"conversations.info",
			{ channel: channelId },
			token,
		);
		const name = res.channel?.name ?? null;
		if (name) channelNames.set(channelId, name);
		return name;
	} catch {
		return null;
	}
}

async function lookupUserName(
	userId: string | null,
	token: string,
): Promise<string | null> {
	if (!userId) return null;
	const cached = userNames.get(userId);
	if (cached) return cached;
	try {
		const res = await slackApi<
			SlackResponse & {
				user?: { real_name?: string; name?: string };
			}
		>("users.info", { user: userId }, token);
		const name = res.user?.real_name ?? res.user?.name ?? null;
		if (name) userNames.set(userId, name);
		return name;
	} catch {
		return null;
	}
}

/** Mentions read as names, not ids. Lookups are cached, so re-syncs are free. */
async function resolveMentions(text: string, token: string): Promise<string> {
	const ids = mentionedUserIds(text);
	if (ids.length === 0) return text;
	const names = new Map<string, string>();
	await Promise.all(
		ids.map(async (id) => {
			const name = await lookupUserName(id, token);
			if (name) names.set(id, name);
		}),
	);
	return replaceMentions(text, names);
}

/**
 * Pull the current queue reactions into the local table.
 *
 * ponytail: one page of `reactions.list` (100 items). Because rows persist, a
 * poll that misses older reactions still accumulates them over time; paginate
 * here if a burst of other reactions ever pushes them off the first page.
 *
 * That page finds new rows. It cannot retire old ones — Slack orders it by
 * when I reacted, so falling off the end says nothing about the message — so
 * retirement is a separate, per-row question at the bottom.
 */
async function syncReactions(token: string, reaction: string): Promise<void> {
	// Every read and write below is fenced to the profile whose token this is.
	// Another profile's rows are not just hidden but untouched — the sweep at
	// the end retires rows Slack stopped reporting, and an unfenced sweep would
	// mark the whole of the other workspace's queue unreacted on every switch.
	const profileId = activeProfileId();
	const me = await getIdentity(token);
	// full=true is load-bearing: without it Slack truncates each reaction's
	// `users` array, and the "is this MY reaction?" check would miss.
	const res = await slackApi<
		SlackResponse & { items?: SlackReactionsListItem[] }
	>("reactions.list", { user: me.userId, limit: "100", full: "true" }, token);
	const items = res.items ?? [];
	const launch = launchReaction();
	const eyed = pickEyedMessages(items, me.userId, reaction, launch);
	const now = Date.now();
	// The first sync ever only records what was already there: reacting before
	// this feature existed wasn't asking for a session. After that, a message
	// launches whenever it was posted — reacting to an old alert is the point.
	const flagged = eyed.filter((m) => m.launch).map((m) => m.id);
	const config = readOdinConfig();
	if (config.slackLaunchSince === undefined) {
		updateOdinConfig({ slackLaunchSince: now, slackLaunchBaseline: flagged });
	} else {
		const baseline = new Set(config.slackLaunchBaseline ?? []);
		for (const id of flagged) if (!baseline.has(id)) launchRequested.add(id);
	}

	const existing = new Map(
		localDb
			.select()
			.from(slackReactions)
			.where(eq(slackReactions.profileId, profileId))
			.all()
			.map((row) => [row.id, row]),
	);

	for (const message of eyed) {
		const text = await resolveMentions(message.text, token);
		if (existing.has(message.id)) {
			// Re-reacting after un-reacting puts the row back in the queue.
			localDb
				.update(slackReactions)
				.set({ lastSeenAt: now, unreactedAt: null, text })
				.where(eq(slackReactions.id, message.id))
				.run();
			continue;
		}
		const [channelName, authorName] = await Promise.all([
			lookupChannelName(message.channelId, token),
			lookupUserName(message.authorId, token),
		]);
		localDb
			.insert(slackReactions)
			.values({
				id: message.id,
				profileId,
				channelId: message.channelId,
				channelName,
				messageTs: message.messageTs,
				authorId: message.authorId,
				authorName,
				text,
				permalink:
					message.permalink ??
					(me.teamUrl
						? buildPermalink({
								teamUrl: me.teamUrl,
								channelId: message.channelId,
								messageTs: message.messageTs,
								threadTs: message.threadTs,
							})
						: null),
				firstSeenAt: now,
				lastSeenAt: now,
			})
			.onConflictDoNothing()
			.run();
	}

	// Retiring a row takes asking about that row. Absence from the page above
	// means nothing — see `rowsToVerify` — and this stamp is what the Review
	// screen turns into a DROP, so it is only ever set off an answer.
	const stillEyed = new Set(eyed.map((message) => message.id));
	for (const row of rowsToVerify(
		[...existing.values()],
		stillEyed,
		VERIFY_PER_SYNC,
	)) {
		const on = await reactionStillOn(row, me.userId, [reaction, launch], token);
		// Couldn't ask — a deleted message, a channel I left, a rate limit.
		// Leave the row exactly as it was rather than guessing at it.
		if (on === null) continue;
		localDb
			.update(slackReactions)
			.set({
				lastSeenAt: now,
				// Already-retired rows keep the time they went, so re-checking one
				// doesn't keep moving when it happened.
				unreactedAt: on ? null : (row.unreactedAt ?? now),
			})
			.where(eq(slackReactions.id, row.id))
			.run();
	}
}

/** How many missing rows one sync asks Slack about. `reactions.get` is tier 3
 * (~50/min) and the queue polls every 2 minutes, so this is nowhere near it. */
const VERIFY_PER_SYNC = 8;

/**
 * What happened in the conversation itself after a queued message.
 *
 * Not every answer is a threaded reply. A DM gets answered in the DM, and the
 * thread rungs above see none of it — which is how a message answered nine
 * days later reads as "nobody has replied, and nothing has moved in 22 days".
 *
 * Read from `conversations.info`, under the `*:read` scopes the queue already
 * has. `last_read` is my read cursor, so it is a *lower bound* on the newest
 * message here — it can lag the conversation, never lead it. That direction is
 * the safe one: it can only make a row look more alive than the thread alone
 * did, never less.
 *
 * `isDirect` decides what the caller may do with it. In a DM my speaking last
 * is the conversation being over; in #rnd it is me saying something unrelated
 * an hour later, and clearing a queued question on that would be exactly the
 * mistake the thread rung just stopped making.
 */
async function conversationAfter(
	channel: string,
	messageTs: string,
	myUserId: string,
	token: string,
): Promise<{
	channelLastTs: string | null;
	channelLastByMe: boolean;
	isDirect: boolean;
}> {
	const quiet = {
		channelLastTs: null,
		channelLastByMe: false,
		isDirect: false,
	};
	try {
		const info = await slackRead<
			SlackResponse & {
				channel?: { last_read?: string; is_im?: boolean; is_mpim?: boolean };
			}
		>("conversations.info", { channel }, token);
		const isDirect = Boolean(info.channel?.is_im || info.channel?.is_mpim);
		const last = info.channel?.last_read ?? null;
		// Nothing after the message itself: no later author to go and read.
		if (!last || Number(last) <= Number(messageTs))
			return { ...quiet, isDirect };
		const author = await slackRead<
			SlackResponse & { message?: { user?: string } }
		>("reactions.get", { channel, timestamp: last, full: "true" }, token);
		return {
			channelLastTs: last,
			channelLastByMe: author.message?.user === myUserId,
			isDirect,
		};
	} catch {
		return quiet;
	}
}

/**
 * Is either queue reaction still on this one message?
 *
 * null is "Slack wouldn't say", which must never read as "the reaction is
 * gone": the row a stamp retires is the row a DROP on the Review screen
 * deletes.
 */
async function reactionStillOn(
	row: { channelId: string; messageTs: string },
	myUserId: string,
	reactions: string[],
	token: string,
): Promise<boolean | null> {
	try {
		const res = await slackApi<
			SlackResponse & {
				message?: { reactions?: { name?: string; users?: string[] }[] };
			}
		>(
			"reactions.get",
			{ channel: row.channelId, timestamp: row.messageTs, full: "true" },
			token,
		);
		return (res.message?.reactions ?? []).some(
			(r) =>
				reactions.includes(r.name ?? "") && (r.users ?? []).includes(myUserId),
		);
	} catch {
		return null;
	}
}

/**
 * The thread under one queued message, for the backlog sweep: how many replies
 * it has, and — the question that decides it — whether the last word is mine.
 *
 * Being somewhere in `reply_users` is not the same as having answered. A
 * thread where I said something in week one and they asked me a question in
 * week three is a thread waiting on me, and reading "I replied" off the list
 * clears exactly the rows that still need doing.
 *
 * Read from `reactions.get`, not `conversations.replies`. Reading the thread
 * itself needs `channels:history` and its three siblings — read access to
 * every message in every channel I'm in — for two facts Slack already puts on
 * the parent message: `reply_count` and `reply_users`. The queue's own
 * `reactions:read` is enough. Asking for history scopes to learn a reply count
 * would be the broadest permission in the app bought for the least.
 *
 * Read-only and best-effort: anything Slack won't answer comes back null and
 * reads as "couldn't check" on the Review screen, never as a reason to clear
 * the row.
 */
export async function slackThreadReplies(id: string): Promise<{
	replies: number;
	/** The newest reply is mine — nobody is waiting on me here. */
	lastReplyByMe: boolean;
	/** I said something in this thread, at some point. */
	iReplied: boolean;
	/** True when `reply_users` is the whole list, so "not mine" means it. */
	repliersComplete: boolean;
	/** Slack ts of the newest reply — the freshest thing that happened here. */
	lastReplyTs: string | null;
	/** Newest thing seen in the conversation itself, reply or not. */
	channelLastTs: string | null;
	/** That newest thing is mine — I said something here after this message. */
	channelLastByMe: boolean;
	/** A DM or group DM, where "I spoke last" is about this and nothing else. */
	isDirect: boolean;
	/**
	 * Someone else the message tagged alongside me, when theirs is the newest
	 * reply and it came after the ask — "@Idan @Dan can you help" that Idan
	 * answered. Their name, or null.
	 */
	answeredBy: string | null;
} | null> {
	const token = slackToken();
	if (!token) return null;
	const [channel, ts] = id.split(":");
	if (!channel || !ts) return null;
	type ThreadMessage = {
		ts?: string;
		thread_ts?: string;
		reply_count?: number;
		reply_users?: string[];
		reply_users_count?: number;
		latest_reply?: string;
		user?: string;
		text?: string;
	};
	const get = (timestamp: string) =>
		slackRead<SlackResponse & { message?: ThreadMessage }>(
			"reactions.get",
			{ channel, timestamp, full: "true" },
			token,
		);
	try {
		const me = await getIdentity(token);
		const res = await get(ts);
		// The row usually points at a reply — you react to the message that needs
		// answering, not to whatever opened the thread — and the thread's facts
		// are on the parent. A failed parent lookup throws to the catch and reads
		// as "couldn't check", which is the honest answer: without it we would be
		// calling a 37-message thread empty.
		const parent = threadParentTs(res.message ?? {});
		const message = (parent ? (await get(parent)).message : res.message) ?? {};
		const repliers = message.reply_users ?? [];
		const iReplied = repliers.includes(me.userId);
		const latest = message.latest_reply ?? null;
		const after = await conversationAfter(channel, ts, me.userId, token);
		// The others the ask was put to. Only a reply newer than the ask can be
		// an answer to it.
		const coAsked = mentionedUserIds(res.message?.text ?? "").filter(
			(user) => user !== me.userId,
		);
		const answerable = latest !== null && Number(latest) > Number(ts);
		// Who spoke last. Only worth a call when it could decide something: I'm
		// in the thread, or someone tagged with me might have answered.
		const lastBy =
			latest && (iReplied || (answerable && coAsked.length > 0))
				? ((await get(latest)).message?.user ?? null)
				: null;
		return {
			replies: message.reply_count ?? 0,
			iReplied,
			...after,
			lastReplyByMe: iReplied && lastBy === me.userId,
			answeredBy:
				answerable && lastBy && coAsked.includes(lastBy)
					? ((await lookupUserName(lastBy, token)) ?? "someone tagged with you")
					: null,
			// Slack caps `reply_users` at five. Past that my absence from the list
			// isn't evidence I stayed out of the thread, and the sweep must not
			// read it as one.
			repliersComplete: repliers.length >= (message.reply_users_count ?? 0),
			lastReplyTs: latest,
		};
	} catch {
		return null;
	}
}

/**
 * What a Slack link points at, for the brief's "My links": the channel, who
 * posted, and the message's first real line — so three "Slack thread" links
 * read as three different conversations.
 *
 * `reactions.get` rather than `conversations.history`: it returns the message
 * on the `reactions:read` scope the queue already has. Cached per link — a
 * message's opening line doesn't change — and null on anything Slack won't
 * answer, which leaves the link on its plain label.
 */
const previews = new Map<string, SlackPreview>();
export interface SlackPreview {
	channel: string | null;
	author: string | null;
	/** The first real line, for the link itself. */
	text: string;
	/** The whole message, for hovering over it. */
	full: string;
}
async function slackPreview(url: string): Promise<SlackPreview | null> {
	const cached = previews.get(url);
	if (cached) return cached;
	const token = slackToken();
	const match = /\/archives\/([\w-]+)\/p(\d{10})(\d{6})/.exec(url);
	if (!token || !match) return null;
	const [, channel, secs, micros] = match;
	try {
		const res = await slackApi<
			SlackResponse & {
				message?: {
					text?: string;
					attachments?: SlackAttachment[];
					user?: string;
				};
			}
		>(
			"reactions.get",
			{ channel, timestamp: `${secs}.${micros}`, full: "true" },
			token,
		);
		const [channelName, author, text] = await Promise.all([
			lookupChannelName(channel, token),
			lookupUserName(res.message?.user ?? null, token),
			resolveMentions(messageBody(res.message ?? {}), token),
		]);
		const preview = {
			channel: channelLabel(channelName),
			author,
			text: toTitle(text),
			full: text,
		};
		previews.set(url, preview);
		return preview;
	} catch {
		return null;
	}
}

export interface ReactionRow {
	id: string;
	title: string;
	text: string;
	channelId: string;
	/** Display-ready: `#eng` for a channel, a member list for a group DM. */
	channelName: string | null;
	authorName: string | null;
	permalink: string | null;
	/** Message post time (Slack ts), ISO. */
	postedAt: string;
	firstSeenAt: number;
	/** The :eyes: is gone from Slack, but the row was kept. */
	unreacted: boolean;
	done: boolean;
	status: ReactionStatus;
	/** Carries my launch reaction and hasn't been started: start it now. */
	autoLaunch: boolean;
}

function readRows(): ReactionRow[] {
	return localDb
		.select()
		.from(slackReactions)
		.where(eq(slackReactions.profileId, activeProfileId()))
		.orderBy(sql`${slackReactions.messageTs} + 0 desc`)
		.limit(500)
		.all()
		.map((row) => ({
			id: row.id,
			title: toTitle(row.text),
			text: row.text,
			channelId: row.channelId,
			channelName: channelLabel(row.channelName),
			authorName: row.authorName,
			permalink: row.permalink,
			postedAt: new Date(Number(row.messageTs) * 1000).toISOString(),
			firstSeenAt: row.firstSeenAt,
			unreacted: row.unreactedAt !== null,
			done: row.doneAt !== null,
			status: reactionStatus(row),
			autoLaunch:
				launchRequested.has(row.id) && reactionStatus(row) === "Not started",
		}));
}

export const createSlackRouter = () => {
	return router({
		/**
		 * The queue. Syncs from Slack first, but a sync failure returns the stored
		 * rows with an error string instead of throwing — a flaky token or a
		 * rate limit shouldn't blank the view.
		 */
		reactions: publicProcedure.query(async () => {
			const token = slackToken();
			const reaction = queueReaction();
			let syncError: string | null = null;
			if (token) {
				try {
					await syncReactions(token, reaction);
				} catch (error) {
					syncError = error instanceof Error ? error.message : String(error);
				}
			}
			return {
				rows: readRows(),
				syncError,
				connected: token !== null,
				reaction,
				launchReaction: launchReaction(),
			};
		}),

		/** Channel, author and opening line for each Slack link, keyed by url. */
		previews: publicProcedure
			.input(z.object({ urls: z.array(z.string()) }))
			.query(async ({ input }) =>
				Object.fromEntries(
					await Promise.all(
						input.urls.map(
							async (url) => [url, await slackPreview(url)] as const,
						),
					),
				),
			),

		/**
		 * Watch for a different emoji — the one that queues, or with `launch` the
		 * one that queues and starts. Rows already queued are left alone.
		 */
		setReaction: publicProcedure
			.input(z.object({ name: z.string(), launch: z.boolean().optional() }))
			.mutation(({ input }) => {
				const reaction = normalizeReaction(input.name);
				updateOdinConfig(
					input.launch
						? { slackLaunchReaction: reaction }
						: { slackReaction: reaction },
				);
				return { reaction };
			}),

		/**
		 * Stamped when a session is launched, which is what puts a row in the
		 * "In progress" pill. First launch wins, so re-opening a session later
		 * doesn't reset when the work actually started.
		 */
		markStarted: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) => {
				localDb
					.update(slackReactions)
					.set({ startedAt: Date.now() })
					.where(
						and(
							eq(slackReactions.id, input.id),
							isNull(slackReactions.startedAt),
						),
					)
					.run();
				return { ok: true };
			}),

		/** Local-only handled marker — Slack is never written to. */
		setDone: publicProcedure
			.input(z.object({ id: z.string(), done: z.boolean() }))
			.mutation(({ input }) => {
				localDb
					.update(slackReactions)
					.set({ doneAt: input.done ? Date.now() : null })
					.where(eq(slackReactions.id, input.id))
					.run();
				return { ok: true };
			}),

		/** Drop a row outright (it comes back if the reaction is still there). */
		remove: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) => {
				localDb
					.delete(slackReactions)
					.where(eq(slackReactions.id, input.id))
					.run();
				return { ok: true };
			}),
	});
};
