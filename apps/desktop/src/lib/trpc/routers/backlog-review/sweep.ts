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
		answeredByMe: boolean;
		lastAuthor: string | null;
	} | null>;
}

/**
 * One item's verdict.
 *
 * DROP is only ever returned off state actually read back from the system that
 * owns the item — a closed ticket, a merged PR, a reaction taken off, a thread
 * I answered myself. Everything unreachable is UNKNOWN, because the button
 * next to a DROP deletes something.
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
		return { verdict: "KEEP", evidence: `${name} is still open` };
	}

	const jira = jiraRef(item);
	if (jira) {
		const status = await deps.jiraStatus(jira);
		if (status)
			return {
				verdict: status.done ? "DROP" : "KEEP",
				evidence: `${jira} is ${status.name}`,
			};
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
		if (thread.answeredByMe)
			return { verdict: "DROP", evidence: "you replied in the thread" };
		if (thread.replies > 0)
			return {
				verdict: "KEEP",
				evidence: `${thread.replies} ${thread.replies === 1 ? "reply" : "replies"}, last from ${thread.lastAuthor ?? "someone else"}`,
			};
		return { verdict: "KEEP", evidence: "nobody has replied" };
	}

	return {
		verdict: "UNKNOWN",
		evidence: jira
			? `Jira had nothing for ${jira}`
			: "nothing upstream to check it against",
	};
}
