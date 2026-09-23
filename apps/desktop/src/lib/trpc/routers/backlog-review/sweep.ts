/**
 * The backlog sweep: does this item's upstream still want it done?
 *
 * Odin asks the systems itself rather than handing the question to an agent.
 * A sweep is a set of lookups — a Jira status, a PR state, whether a thread
 * moved on — and Odin is already signed in to all three. Doing it here makes
 * it a screen that fills in seconds instead of a session you start, wait for,
 * and read a transcript of. The judgement stays where it belongs: nothing is
 * cleared without a click on the Review screen.
 *
 * No electron in here — the lookups arrive as `SweepDeps`, so every branch is
 * testable without a token (sweep.test.ts).
 */

/** One backlog row, as much of it as a lookup needs. */
export interface SweepItem {
	/** `task:<id>` / `slack:<channel>:<ts>` — the row to clear on DROP. */
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
	 * Slack message's own timestamp — whatever the source calls it.
	 */
	lastActivityAt?: number;
}

/**
 * How long a row can sit with nothing happening to it before the sweep calls
 * it rot.
 *
 * Three weeks, off the shape of a real backlog: rows cluster under two weeks
 * (live) and past three (dead), with a gap between. This is the one rule here
 * that isn't a fact read back from somewhere — it is a judgement about how
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
 * A Jira key as it appears in prose. Deliberately loose — `UTF-8` matches too
 * — because a key nobody's Jira has comes back as "not found", which the
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

/** The Slack message a queue row came from: `slack:<channel>:<ts>`. */
export function slackRef(item: SweepItem): string | null {
	const [kind, ...rest] = item.key.split(":");
	return kind === "slack" && rest.length === 2 ? rest.join(":") : null;
}

/**
 * The three questions the sweep can ask. Each answers null for "couldn't ask"
 * — not signed in, not found, scope missing — which always reads as UNKNOWN
 * rather than as an answer.
 */
export interface SweepDeps {
	jiraStatus(key: string): Promise<{ name: string; done: boolean } | null>;
	githubState(
		ref: Extract<Reference, { kind: "github" }>,
	): Promise<{ state: string; merged: boolean } | null>;
	slackThread(id: string): Promise<{
		replies: number;
		/** The newest reply is mine — nobody is waiting on me here. */
		lastReplyByMe: boolean;
		/** I said something in the thread, at some point. */
		iReplied: boolean;
		/** False when Slack truncated the replier list — see `slackThreadReplies`. */
		repliersComplete: boolean;
		/** Slack ts of the newest reply, when the thread has one. */
		lastReplyTs: string | null;
		/** Newest thing seen in the conversation itself, reply or not. */
		channelLastTs: string | null;
		/** That newest thing is mine — I said something here afterwards. */
		channelLastByMe: boolean;
		/** A DM or group DM, where "I spoke last" is about this and nothing else. */
		isDirect: boolean;
	} | null>;
}

/**
 * One item's verdict.
 *
 * DROP comes off state actually read back from the system that owns the item —
 * a closed ticket, a merged PR, a reaction taken off, a thread I answered
 * myself — or, where the source still says "open", off that source having gone
 * quiet for {@link STALE_DAYS}. Everything *unreachable* stays UNKNOWN, because
 * the button next to a DROP deletes something: age can retire a row the source
 * confirmed, never one it refused to talk about.
 */
export async function sweepItem(
	item: SweepItem,
	deps: SweepDeps,
): Promise<Answer> {
	// Cheapest and strongest: the :eyes: that queued this is gone from the
	// message, which is what dealing with it looks like from Slack's side.
	if (item.unreacted)
		return {
			verdict: "DROP",
			evidence: "the :eyes: is off the message in Slack",
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
		return keepOrStale(`${name} is still open`, activity);
	}

	const jira = jiraRef(item);
	if (jira) {
		const status = await deps.jiraStatus(jira);
		if (status)
			return status.done
				? { verdict: "DROP", evidence: `${jira} is ${status.name}` }
				: keepOrStale(`${jira} is ${status.name}`, activity);
		// Not a real key, or Jira is out of reach. Either way there may still be
		// a thread under a Slack row worth reading, so fall through.
	}

	const slack = slackRef(item);
	if (slack) {
		const thread = await deps.slackThread(slack);
		if (!thread)
			return {
				verdict: "UNKNOWN",
				evidence: jira
					? `couldn't check ${jira}, and couldn't read the thread`
					: "couldn't read the thread",
			};
		// Having the last word is what "I dealt with it" looks like from Slack.
		// Merely appearing in the thread is not: answering in week one and being
		// asked something in week three is a row that still needs doing.
		if (thread.lastReplyByMe)
			return {
				verdict: "DROP",
				evidence: "you had the last word in the thread",
			};
		// Not every answer is a threaded reply — a DM gets answered in the DM.
		// Only in a direct conversation: in a channel, me saying something later
		// is me saying something later, not me dealing with this.
		if (thread.isDirect && thread.channelLastByMe)
			return { verdict: "DROP", evidence: "you answered in the DM afterwards" };
		// A reply is the freshest thing that happened here, and the row's own
		// timestamp is the message — so a long-dead thread under an old message
		// still reads as quiet, and one answered yesterday doesn't.
		// The freshest of everything actually seen: a reply, something said in the
		// conversation since, or failing both the message's own timestamp.
		const seen = [
			thread.lastReplyTs ? Number(thread.lastReplyTs) * 1000 : null,
			// Only in a DM. In a channel this is "the channel is busy", which is
			// true of every channel worth being in and would keep every row alive
			// forever — a row in #rnd is judged on its own thread, not on whether
			// #rnd said something this morning.
			thread.isDirect && thread.channelLastTs
				? Number(thread.channelLastTs) * 1000
				: null,
			activity ?? slackTs(slack),
		].filter((at): at is number => at !== null);
		const moved = seen.length > 0 ? Math.max(...seen) : null;
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
		return keepOrStale("nobody has replied", moved);
	}

	if (jira)
		return { verdict: "UNKNOWN", evidence: `Jira had nothing for ${jira}` };
	// Nothing to ask is not the same as asking and getting no answer. A task I
	// typed has no upstream and never will, so its age is the only thing there
	// is to go on — which is a checked row, not an unreadable one.
	return keepOrStale("nothing upstream to check it against", activity);
}

/** The post time, ms, out of a `<channel>:<ts>` Slack reference. */
function slackTs(ref: string): number | null {
	const ts = Number(ref.split(":")[1]);
	return Number.isFinite(ts) ? ts * 1000 : null;
}
