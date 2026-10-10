/**
 * The backlog sweep: does this item's upstream still want it done?
 *
 * Odin asks the systems itself rather than handing the question to an agent.
 * A sweep is a set of lookups - a Jira status, a PR state, whether a thread
 * moved on - and Odin is already signed in to all three. Doing it here makes
 * it a screen that fills in seconds instead of a session you start, wait for,
 * and read a transcript of. The judgement stays where it belongs: nothing is
 * cleared without a click on the Review screen.
 *
 * No electron in here - the lookups arrive as `SweepDeps`, so every branch is
 * testable without a token (sweep.test.ts).
 */

/** One backlog row, as much of it as a lookup needs. */
export interface SweepItem {
	/** `task:<id>` / `slack:<channel>:<ts>` - the row to clear on DROP. */
	key: string;
	source: string;
	title: string;
	/** Notes, or what was said in the message: where a ticket key usually hides. */
	detail?: string;
	url?: string;
	/** Slack only: the :eyes: is gone from the message upstream. */
	unreacted?: boolean;
	/**
	 * When the thing this row points at last moved, ms. A Jira issue's
	 * `updated`, a PR's `updated_at`, a Notion page's `last_edited_time`, the
	 * Slack message's own timestamp - whatever the source calls it.
	 */
	lastActivityAt?: number;
	/** The source's own status name, where it keeps one: a Notion row's Status. */
	status?: string;
	/** An email row's sender, as the mail client shows it. */
	sender?: string;
}

/**
 * How long a row can sit with nothing happening to it before the sweep calls
 * it rot.
 *
 * Three weeks, off the shape of a real backlog: rows cluster under two weeks
 * (live) and past three (dead), with a gap between. This is the one rule here
 * that isn't a fact read back from somewhere - it is a judgement about how
 * long "still worth doing" survives silence, which is why it only ever turns a
 * KEEP into a DROP and never speaks over an answer the source gave.
 */
export const STALE_DAYS = 21;

/**
 * KEEP, unless nothing has happened to it for {@link STALE_DAYS}.
 *
 * The evidence keeps whatever the rung found and says the age on top, so a
 * DROP off silence still shows what was actually read.
 */
function keepOrStale(evidence: string, activityAt: number | null): Answer {
	if (activityAt === null) return { verdict: "KEEP", evidence };
	const idle = (Date.now() - activityAt) / 86_400_000;
	if (idle < STALE_DAYS) return { verdict: "KEEP", evidence };
	return {
		verdict: "DROP",
		evidence: `${evidence}, and nothing has moved in ${Math.round(idle)} days`,
	};
}

export type VerdictName = "DROP" | "KEEP" | "UNKNOWN";

/** What the sweep concluded, and the state it read to conclude it. */
export interface Answer {
	verdict: VerdictName;
	evidence: string;
}

export type Reference =
	| {
			kind: "github";
			owner: string;
			repo: string;
			number: number;
			issue: boolean;
	  }
	| { kind: "jira"; key: string };

const GITHUB_REF = /github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/i;
/**
 * A Jira key as it appears in prose. Deliberately loose - `UTF-8` matches too
 * - because a key nobody's Jira has comes back as "not found", which the
 * caller then treats as "no reference" and moves on to the next check. A
 * denylist would be one more list to maintain for the same outcome.
 */
const JIRA_REF = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/;

/** Everything about an item a reference could be hiding in. */
function haystack(item: SweepItem): string {
	return [item.title, item.detail, item.url].filter(Boolean).join("\n");
}

export function githubRef(
	item: SweepItem,
): Extract<Reference, { kind: "github" }> | null {
	const found = GITHUB_REF.exec(haystack(item));
	if (!found) return null;
	const [, owner, repo, type, number] = found;
	return {
		kind: "github",
		owner,
		repo: repo.replace(/\.git$/, ""),
		number: Number(number),
		issue: type.toLowerCase() === "issues",
	};
}

export function jiraRef(item: SweepItem): string | null {
	// Not inside a GitHub URL: `…/pull/12` has no key in it, but a branch name
	// pasted alongside one does, and the URL is the better reference anyway.
	return JIRA_REF.exec(haystack(item))?.[0] ?? null;
}

const SLACK_LINK = /slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/;

/**
 * The Slack message a row is about, as `<channel>:<ts>`: a queue row's own key,
 * or a permalink in anything else - an inbox copy in Notion carries the link
 * to the message it was copied from, and the thread there is what says
 * whether it's still open.
 */
export function slackRef(item: SweepItem): string | null {
	const [kind, ...rest] = item.key.split(":");
	if (kind === "slack") return rest.length === 2 ? rest.join(":") : null;
	const link = SLACK_LINK.exec(
		[item.detail, item.url].filter(Boolean).join("\n"),
	);
	return link ? `${link[1]}:${link[2]}.${link[3]}` : null;
}

/**
 * Rows that are another row over again: an inbox copy of a Slack message the
 * queue already has. The Slack row is the one to act on - it has the thread,
 * the :eyes: and the Done marker - so the copy is dropped with a pointer to it.
 */
export function duplicates(items: SweepItem[]): Map<string, Answer> {
	const queued = new Set(
		items.filter((item) => item.key.startsWith("slack:")).map(slackRef),
	);
	const out = new Map<string, Answer>();
	for (const item of items) {
		if (item.key.startsWith("slack:")) continue;
		const ref = slackRef(item);
		if (ref && queued.has(ref))
			out.set(item.key, {
				verdict: "DROP",
				evidence: "the same Slack message is on the board as its own row",
			});
	}
	return out;
}

/** A status that means the source considers it finished, whatever it's called. */
const FINISHED_STATUS =
	/^(done|complete(d)?|closed|resolved|rejected|cancell?ed|won'?t do|archived)$/i;

/**
 * Mail no person wrote: a product notification, a confirmation code, a
 * password reminder. Judged on the address's local part, which is what these
 * senders have in common and a colleague's address never is.
 */
const AUTOMATED_SENDER =
	/\b(no-?reply|do-?not-?reply|info|notifications?|support|mailer(-daemon)?|newsletter|news)@/i;

/**
 * The three questions the sweep can ask. Each answers null for "couldn't ask"
 * - not signed in, not found, scope missing - which always reads as UNKNOWN
 * rather than as an answer.
 */
export interface SweepDeps {
	jiraStatus(key: string): Promise<{
		name: string;
		done: boolean;
		/** See {@link jiraMovedAt}. Beats the feed's `updated` when present. */
		movedAt?: number | null;
		/** Who it's assigned to, when that's someone other than me. */
		owner?: string | null;
		/** Its newest comment is someone else @-mentioning me. */
		askedOfMe?: boolean;
	} | null>;
	githubState(ref: Extract<Reference, { kind: "github" }>): Promise<{
		state: string;
		merged: boolean;
		/** Someone else's PR that someone other than me approved: their login. */
		approvedBy?: string | null;
		/** Someone else's PR with merge conflicts: days since its last commit. */
		conflictedForDays?: number | null;
		/** Review asked of this team, not of me, and I haven't reviewed: its slug. */
		teamOnly?: string | null;
	} | null>;
	slackThread(id: string): Promise<{
		replies: number;
		/** The newest reply is mine - nobody is waiting on me here. */
		lastReplyByMe: boolean;
		/** I said something in the thread, at some point. */
		iReplied: boolean;
		/** False when Slack truncated the replier list - see `slackThreadReplies`. */
		repliersComplete: boolean;
		/** Slack ts of the newest reply, when the thread has one. */
		lastReplyTs: string | null;
		/** Newest thing seen in the conversation itself, reply or not. */
		channelLastTs: string | null;
		/** That newest thing is mine - I said something here afterwards. */
		channelLastByMe: boolean;
		/** I reacted to that newest thing (not with :eyes:): acknowledged. */
		channelLastAckedByMe?: boolean;
		/** What that newest thing said. */
		channelLastText?: string | null;
		/** What the newest reply after the ask said. */
		lastReplyText?: string | null;
		/** The newest reply is someone else's, and I reacted to it (not :eyes:). */
		lastReplyAckedByMe?: boolean;
		/** A DM or group DM, where "I spoke last" is about this and nothing else. */
		isDirect: boolean;
		/** Someone tagged alongside me gave the newest reply, after the ask. */
		answeredBy?: string | null;
	} | null>;
}

/**
 * One item's verdict.
 *
 * DROP comes off state actually read back from the system that owns the item -
 * a closed ticket, a merged PR, a reaction taken off, a thread someone
 * tagged with me answered - or, where the source still says "open", off that source having gone
 * quiet for {@link STALE_DAYS}. Everything *unreachable* stays UNKNOWN, because
 * the button next to a DROP deletes something: age can retire a row the source
 * confirmed, never one it refused to talk about.
 */
export async function sweepItem(
	item: SweepItem,
	deps: SweepDeps,
): Promise<Answer> {
	// Cheapest and strongest: the :eyes: or Later save that queued this is
	// gone, which is what dealing with it looks like from Slack's side.
	if (item.unreacted)
		return {
			verdict: "DROP",
			evidence: "it's no longer :eyes:'d or saved for later in Slack",
		};

	if (item.status && FINISHED_STATUS.test(item.status.trim()))
		return {
			verdict: "DROP",
			evidence: `it's marked ${item.status} in ${item.source}`,
		};
	if (item.sender && AUTOMATED_SENDER.test(item.sender))
		return {
			verdict: "DROP",
			evidence: `an automated email from ${item.sender}`,
		};

	const activity = item.lastActivityAt ?? null;

	const github = githubRef(item);
	if (github) {
		const state = await deps.githubState(github);
		const name = `${github.owner}/${github.repo}#${github.number}`;
		if (!state)
			return {
				verdict: "UNKNOWN",
				evidence: `GitHub didn't answer for ${name}`,
			};
		if (state.merged) return { verdict: "DROP", evidence: `${name} is merged` };
		if (state.state === "closed")
			return { verdict: "DROP", evidence: `${name} is closed` };
		// A review request someone else already approved: the PR has the review
		// it needed, so nobody is waiting on mine.
		if (state.approvedBy)
			return {
				verdict: "DROP",
				evidence: `${name} is already approved by ${state.approvedBy}`,
			};
		// Conflicted and untouched for the stale window: the author walked away
		// from it, and a review would be of code that no longer merges.
		if (
			state.conflictedForDays != null &&
			state.conflictedForDays >= STALE_DAYS
		)
			return {
				verdict: "DROP",
				evidence: `${name} has merge conflicts and no commit in ${state.conflictedForDays} days`,
			};
		// The PR's own row only: a Slack message asking me to review it is a
		// request of me, whatever the PR says.
		if (state.teamOnly && item.key.startsWith("pr:"))
			return {
				verdict: "DROP",
				evidence: `${name} asks @${state.teamOnly} for a review, not you`,
			};
		return keepOrStale(`${name} is still open`, activity);
	}

	const jira = jiraRef(item);
	if (jira) {
		const status = await deps.jiraStatus(jira);
		if (status?.done)
			return { verdict: "DROP", evidence: `${jira} is ${status.name}` };
		// A ticket on the board because I filed it or was mentioned on it, now
		// someone else's to finish. Only the ticket's own row: a Slack message
		// asking me about someone else's ticket is still asking me.
		if (status?.owner && !status.askedOfMe && item.key.startsWith("jira:"))
			return {
				verdict: "DROP",
				evidence: `${jira} is ${status.name} and assigned to ${status.owner}`,
			};
		if (status)
			return keepOrStale(
				`${jira} is ${status.name}`,
				status.movedAt ?? activity,
			);
		// Not a real key, or Jira is out of reach. Either way there may still be
		// a thread under a Slack row worth reading, so fall through.
	}

	const slack = slackRef(item);
	// An @channel post that asks nothing: I read it, which was all it wanted.
	if (
		slack &&
		item.key.startsWith("slack:") &&
		isAnnouncement(item.detail ?? item.title)
	)
		return {
			verdict: "DROP",
			evidence: "an @channel announcement that asks nothing of you",
		};
	if (slack) {
		const thread = await deps.slackThread(slack);
		if (!thread)
			return {
				verdict: "UNKNOWN",
				evidence: jira
					? `couldn't check ${jira}, and couldn't read the thread`
					: "couldn't read the thread",
			};
		// A reply is the freshest thing that happened here, and the row's own
		// timestamp is the message - so a long-dead thread under an old message
		// still reads as quiet, and one answered yesterday doesn't.
		// The freshest of everything actually seen: a reply, something said in the
		// conversation since, or failing both the message's own timestamp.
		const seen = [
			thread.lastReplyTs ? Number(thread.lastReplyTs) * 1000 : null,
			// Only in a DM. In a channel this is "the channel is busy", which is
			// true of every channel worth being in and would keep every row alive
			// forever - a row in #rnd is judged on its own thread, not on whether
			// #rnd said something this morning.
			thread.isDirect && thread.channelLastTs
				? Number(thread.channelLastTs) * 1000
				: null,
			activity ?? slackTs(slack),
		].filter((at): at is number => at !== null);
		const moved = seen.length > 0 ? Math.max(...seen) : null;
		// The ask went to me and someone else, and they took it: the thread's
		// last word is theirs, posted after the ask. Nobody is waiting on me.
		if (thread.answeredBy)
			return {
				verdict: "DROP",
				evidence: `${thread.answeredBy}, tagged with you, answered in the thread`,
			};
		const last = lastWord(thread);
		if (last?.byMe && last.text && !PROMISE.test(last.text))
			return {
				verdict: "DROP",
				evidence: `you answered last in the ${last.where}: “${clip(last.text)}”`,
			};
		// "Nevermind, I have it now" 👍: their last word, and I acknowledged it.
		if (last && !last.byMe && last.acked)
			return {
				verdict: "DROP",
				evidence: `you reacted to their last message in the ${last.where}`,
			};
		if (last && !last.byMe && last.text && closes(last.text))
			return {
				verdict: "DROP",
				evidence: `they closed it in the ${last.where}: “${clip(last.text)}”`,
			};
		// Replying with a promise is not finishing: "on it", "will check
		// tomorrow" - the row stays until the promise is kept.
		if (thread.lastReplyByMe)
			return keepOrStale("you replied last in the thread", moved);
		// Only in a direct conversation: in a channel, me saying something later
		// is me saying something later, not me replying to this.
		if (thread.isDirect && thread.channelLastByMe)
			return keepOrStale("you replied last in the DM", moved);
		if (thread.replies > 0) {
			const count = `${thread.replies} ${thread.replies === 1 ? "reply" : "replies"}`;
			// Only claim none of them are mine when Slack listed every replier.
			// A truncated list says nothing about who isn't on it.
			const whose = thread.iReplied
				? ", and they answered after you"
				: thread.repliersComplete
					? ", none from you"
					: "";
			return keepOrStale(`${count}${whose}`, moved);
		}
		// The DM went on after the ask, and not from me: someone did reply.
		if (thread.isDirect && thread.channelLastTs && !thread.channelLastByMe)
			return keepOrStale("they wrote last in the DM", moved);
		return keepOrStale("nobody has replied", moved);
	}

	if (jira)
		return { verdict: "UNKNOWN", evidence: `Jira had nothing for ${jira}` };
	// Nothing to ask is not the same as asking and getting no answer. A task I
	// typed has no upstream and never will, so its age is the only thing there
	// is to go on - which is a checked row, not an unreadable one.
	return keepOrStale("nothing upstream to check it against", activity);
}

/** The parts of a Jira issue (`?fields=created,comment&expand=changelog`) that say it moved. */
export interface JiraActivity {
	fields?: {
		created?: string;
		comment?: { total?: number; comments?: { created?: string }[] };
	};
	changelog?: {
		total?: number;
		histories?: { created?: string; items?: { field?: string }[] }[];
	};
}

/**
 * What a sprint carry-over writes. Every unfinished ticket is moved into the
 * next sprint, which bumps `updated` - so a ticket nobody has looked at in a
 * year reads as touched two weeks ago, forever, and never goes stale.
 */
const CARRY_OVER_FIELDS = new Set(["Sprint", "Rank"]);

/**
 * When someone last did something to the issue, ms: a comment, or a change
 * that isn't a carry-over. Null when Jira cut a list short - the missing entry
 * could be the newest - so the caller falls back to `updated`.
 */
export function jiraMovedAt(issue: JiraActivity): number | null {
	const histories = issue.changelog?.histories ?? [];
	const comments = issue.fields?.comment?.comments ?? [];
	if ((issue.changelog?.total ?? 0) > histories.length) return null;
	if ((issue.fields?.comment?.total ?? 0) > comments.length) return null;
	const times = [
		issue.fields?.created,
		...comments.map((comment) => comment.created),
		...histories
			.filter((history) =>
				history.items?.some(
					(change) => !CARRY_OVER_FIELDS.has(change.field ?? ""),
				),
			)
			.map((history) => history.created),
	]
		.map((iso) => (iso ? Date.parse(iso) : Number.NaN))
		.filter(Number.isFinite);
	return times.length > 0 ? Math.max(...times) : null;
}

/** The parts of a Jira issue that say whose it is. */
export interface JiraOwnership {
	fields?: {
		assignee?: { accountId?: string; displayName?: string } | null;
		comment?: {
			total?: number;
			comments?: { author?: { accountId?: string }; body?: unknown }[];
		};
	};
}

/**
 * Whether a ticket is someone else's to finish: assigned to another person,
 * and its newest comment isn't that person (or anyone) @-mentioning me - a
 * mention is how Jira hands a question back. A cut-short comment list can't
 * say which comment is newest, so it counts as asked.
 */
export function jiraOwnership(
	issue: JiraOwnership,
	myAccountId: string | null,
): { owner: string | null; askedOfMe: boolean } {
	const assignee = issue.fields?.assignee;
	const owner =
		myAccountId && assignee?.accountId && assignee.accountId !== myAccountId
			? (assignee.displayName ?? "someone else")
			: null;
	const comments = issue.fields?.comment?.comments ?? [];
	if ((issue.fields?.comment?.total ?? 0) > comments.length)
		return { owner, askedOfMe: true };
	const newest = comments.at(-1);
	const askedOfMe = Boolean(
		myAccountId &&
			newest &&
			newest.author?.accountId !== myAccountId &&
			JSON.stringify(newest.body ?? "").includes(myAccountId),
	);
	return { owner, askedOfMe };
}

type Thread = NonNullable<Awaited<ReturnType<SweepDeps["slackThread"]>>>;

/**
 * The newest message after the ask, wherever it was said: the thread's last
 * reply, or - in a DM, where answers usually come inline - the conversation's
 * newest message, whichever is later.
 */
function lastWord(thread: Thread): {
	byMe: boolean;
	text: string | null;
	acked: boolean;
	where: "thread" | "DM";
} | null {
	const reply = thread.lastReplyTs
		? {
				at: Number(thread.lastReplyTs),
				byMe: thread.lastReplyByMe,
				text: thread.lastReplyText ?? null,
				acked: thread.lastReplyAckedByMe ?? false,
				where: "thread" as const,
			}
		: null;
	const dm =
		thread.isDirect && thread.channelLastTs
			? {
					at: Number(thread.channelLastTs),
					byMe: thread.channelLastByMe,
					text: thread.channelLastText ?? null,
					acked: thread.channelLastAckedByMe ?? false,
					where: "DM" as const,
				}
			: null;
	const newest = reply && dm ? (dm.at > reply.at ? dm : reply) : (reply ?? dm);
	if (!newest) return null;
	const { at: _at, ...rest } = newest;
	return rest;
}

/**
 * A reply that promises rather than delivers: "fixing this", "will look",
 * "not yet", "note to self: remaining photos". Anything else I say last - "Fixed", "Created", a link, an
 * answer, "lmk if it works" - hands the ball back, and nobody waits on me.
 *
 * ponytail: a phrase list, measured against 71 hand-read rows (every promise
 * caught; "note to self" / "todo" / "remaining" added after a miss). Swap for a model call if it drifts.
 */
export const PROMISE =
	/\b(will|i'?ll|we'?ll|fixing|looking|checking|investigating|working on|on it|not yet|soon|tomorrow|later|let me (check|look|see)|note to self|todo|to-?do|remaining|left to)\b|אבדוק|נבדוק|בודק|אעדכן|נעדכן|אסתכל|מחר|עוד מעט|בהמשך|אחזור|עובד על/i;

/** "Thanks", "👍", "works!", "תודה": a short last word that closes it. */
const CLOSING =
	/^(:\+1:|:thumbsup:|:pray:|:white_check_mark:|:heavy_check_mark:|👍|🙏|✅)|\b(thanks?|thank you|thx|cool|great|perfect|awesome|works|worked|done|fixed|resolved|solved|got it|sounds good|all good)\b|תודה|עובד|מעולה|סבבה|אחלה|יופי/i;
/** Still waiting, however politely: "thanks, looking forward to the fix". */
const STILL_WAITING =
	/\?|looking forward|once|when|waiting|let me know|lmk|update|still/i;

/** Slack markup out: mentions, channel links, emoji codes kept as-is. */
function bare(text: string): string {
	return text.replace(/<[@#!][^>]*>/g, "").trim();
}

export function closes(text: string): boolean {
	const said = bare(text);
	return said.length <= 60 && CLOSING.test(said) && !STILL_WAITING.test(said);
}

export function isAnnouncement(text: string): boolean {
	return (
		/(^|\s)(@channel|@here|<!channel>|<!here>)/i.test(text) &&
		!text.includes("?")
	);
}

function clip(text: string): string {
	const said = bare(text).replace(/\s+/g, " ");
	return said.length > 60 ? `${said.slice(0, 57)}…` : said;
}

export interface Review {
	state?: string;
	user?: { login?: string };
}

/**
 * Someone other than `me` whose standing review is an approval. A reviewer's
 * latest approve/request-changes stands; comments don't change it and a
 * dismissal takes it back.
 */
export function approverOf(reviews: Review[], me: string): string | null {
	const latest = new Map<string, string>();
	for (const review of reviews) {
		const login = review.user?.login;
		if (!login || login.toLowerCase() === me) continue;
		if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")
			latest.set(login, review.state);
		else if (review.state === "DISMISSED") latest.delete(login);
	}
	for (const [login, state] of latest) if (state === "APPROVED") return login;
	return null;
}

/** The post time, ms, out of a `<channel>:<ts>` Slack reference. */
function slackTs(ref: string): number | null {
	const ts = Number(ref.split(":")[1]);
	return Number.isFinite(ts) ? ts * 1000 : null;
}

/** `Promise.all` over `items`, at most `limit` in flight, results in order. */
export async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return out;
}
