import type { PullRequestRow } from "lib/trpc/routers/work";

/**
 * The open PR that makes a ticket mine to review: one I opened (an agent's,
 * waiting on my look and merge) or one someone asked me to review, naming the
 * ticket's key in its title or body. A draft isn't ready for anyone yet, and a
 * PR I'm only @-named on isn't asking me for a review.
 *
 * ponytail: matches the key as text, so a PR that links the ticket only by
 * branch name is missed; Jira's Development field is the upgrade.
 */
export function reviewPullFor(
	key: string,
	pulls: PullRequestRow[],
): PullRequestRow | undefined {
	const names = new RegExp(`\\b${key}\\b`);
	return pulls.find(
		(pull) =>
			pull.kind !== "mentioned" &&
			!pull.draft &&
			names.test(`${pull.title}\n${pull.body ?? ""}`),
	);
}
