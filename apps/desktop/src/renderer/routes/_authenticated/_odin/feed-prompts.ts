/**
 * The prompts a Jira ticket and a pull request start a session from.
 *
 * They live out here, next to buildThreadPrompt, because two views start the
 * same row: its own feed, and the All roll-up. A prompt builder inside a
 * route page can't be shared with either.
 */

/** Investigate-first prompt, so the agent reads the ticket before touching code. */
export function buildIssuePrompt(
	key: string,
	url: string,
	title: string,
): string {
	return [
		`This task is Jira issue ${key}: ${title}`,
		`Ticket: ${url}`,
		"",
		"PHASE 1 — UNDERSTAND (do this first):",
		`- Read ${key} in full: description, acceptance criteria, comments, linked issues and attachments.`,
		"- If the repo isn't obvious from the ticket, work it out from the code before changing anything.",
		"",
		"PHASE 2 — EXECUTE:",
		"- Investigate the root cause, make the change, and verify it when practical.",
		"",
		"Rules: do NOT comment on the ticket or move it — everything stays in this session for review.",
	].join("\n");
}

/** Review someone else's PR, push mine along, or answer a thread I was named
 * on — same reading, different job. */
export function buildReviewPrompt(
	url: string,
	title: string,
	repo: string,
	kind: "review" | "mine" | "mentioned",
): string {
	// A mention lands on issues as well as PRs, so this one stays about the
	// thread rather than the diff.
	if (kind === "mentioned") {
		return [
			`Someone mentioned you here: ${title}`,
			`Link: ${url}`,
			`Repo: ${repo}`,
			"",
			"- Read the thread and work out what is being asked of you.",
			"- Answer it here: what you would reply, and what it would take to do.",
			"",
			"Rules: do NOT comment on GitHub — leave the reply here for me to send.",
		].join("\n");
	}
	const shared = [
		`Pull request: ${url}`,
		`Repo: ${repo}`,
		`Title: ${title}`,
		"",
		"PHASE 1 — READ (do this first):",
		"- Read the PR: description, the full diff, CI status, and existing review comments.",
		"- Check out the branch locally if you need to run or trace anything.",
		"",
	];
	return kind === "review"
		? [
				`Review this pull request: ${title}`,
				...shared,
				"PHASE 2 — REVIEW:",
				"- Look for correctness bugs first, then missing tests, then simplifications.",
				"- Report findings with file:line and a concrete fix for each.",
				"",
				"Rules: do NOT post the review to GitHub — leave it here for me to send.",
			].join("\n")
		: [
				`Work on my pull request: ${title}`,
				...shared,
				"PHASE 2 — EXECUTE:",
				"- Address outstanding review comments and failing CI.",
				"- Verify your changes, then summarise what's left.",
				"",
				"Rules: do NOT merge, and do NOT comment on GitHub — everything stays here for review.",
			].join("\n");
}
