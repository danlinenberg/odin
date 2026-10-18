/**
 * What the PR-rules hook injects, shared so the brief can find its firings in
 * a transcript (see `ruleFirings`) without the two drifting apart.
 */
export const PR_RULES_HEADER =
	"You just opened or pushed to a pull request. Do these now, before anything else - again on every later push to it:";

/** Bash commands that open or change a PR - what the hook fires on. */
export const PR_COMMAND = "gh pr (create|edit|ready)|git push";

/** "When <when>, <action>" - a standing instruction for every session Odin starts. */
export interface OdinRule {
	id: string;
	when: string;
	action: string;
	paused?: boolean;
	/** Only sessions in these checkouts get it - none means every session. */
	repos?: string[];
	/** Flip `repos`: every session EXCEPT the ones in those checkouts. */
	exclude?: boolean;
}

/**
 * The switched-on rules that reach a session in `checkout` - "" when the
 * checkout isn't known, which keeps the repo-pinned ones (see `ruleLine`).
 */
export function liveRules(rules: OdinRule[], checkout: string): OdinRule[] {
	return rules.filter(
		(r) =>
			!r.paused &&
			r.when &&
			r.action &&
			(!r.repos?.length ||
				!checkout ||
				r.repos.some((repo) => inRepo(checkout, repo)) !== !!r.exclude),
	);
}

const inRepo = (checkout: string, repo: string) =>
	checkout === repo || checkout.startsWith(`${repo}/`);

/** One rule as the agent reads it - the repos named when it's pinned to some. */
const ruleLine = (r: OdinRule) =>
	`- When ${r.when}${r.repos?.length ? ` (${r.exclude ? "except" : "only"} in ${r.repos.length > 1 ? "the repos at" : "the repo at"} ${r.repos.join(", ")})` : ""}: ${r.action}`;

/** Heads the rules in a launch prompt - the brief finds them by it. */
export const RULES_HEADER =
	"Standing rules - follow each one whenever its situation comes up during this session, without being asked:";

/** The rules as prompt lines - nothing when there are none switched on. */
export function rulesPrompt(rules: OdinRule[], checkout = ""): string[] {
	const live = liveRules(rules, checkout);
	if (live.length === 0) return [];
	return ["", RULES_HEADER, ...live.map(ruleLine)];
}

/** A rule about pull requests - the only situation a hook can see happen. */
const PR_RULE = /pull request|\bPRs?\b|\bpush/i;

/** Single-quote for sh. */
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * `claude --settings` JSON that fires the PR rules after every Bash call that
 * opens or pushes to a PR - every time the PR changes, not just the first.
 * Null when no live rule is about PRs.
 */
export function rulesSettings(rules: OdinRule[], checkout = ""): string | null {
	const live = liveRules(rules, checkout).filter((r) => PR_RULE.test(r.when));
	if (live.length === 0) return null;
	const context = [PR_RULES_HEADER, ...live.map(ruleLine)].join("\n");
	const output = JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PostToolUse",
			additionalContext: context,
		},
	});
	const command = `grep -qE ${sh(PR_COMMAND)} && printf '%s' ${sh(output)}; exit 0`;
	return JSON.stringify({
		hooks: {
			PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }],
		},
	});
}
