/**
 * What the PR-rules hook injects, shared so the brief can find its firings in
 * a transcript (see `ruleFirings`) without the two drifting apart.
 */
export const PR_RULES_HEADER =
	"You just opened or pushed to a pull request. Do these now, before anything else — again on every later push to it:";

/** Bash commands that open or change a PR — what the hook fires on. */
export const PR_COMMAND = "gh pr (create|edit|ready)|git push";
