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
 * A rule's repos as the store keeps them: a list of paths, or none. Rules
 * also arrive from agents, through the raven API (action=run store=rules
 * fn=add / fn=update) with whatever JSON they sent - one path as a bare
 * string, at times. Kept as sent, that string passed `repos?.length` and
 * then threw at `repos.join`, which blocked every new session.
 */
export function reposOf(value: unknown): string[] | undefined {
	const repos = (Array.isArray(value) ? value : [value]).filter(
		(repo): repo is string => typeof repo === "string" && repo !== "",
	);
	return repos.length ? repos : undefined;
}

/** The rule with its repos as `reposOf` reads them, or without the field. */
export function withRepos<R extends OdinRule>(rule: R): R {
	const { repos, ...rest } = rule;
	const list = reposOf(repos);
	return (list ? { ...rest, repos: list } : rest) as R;
}

/**
 * The switched-on rules that reach a session in `checkout` - "" when the
 * checkout isn't known, which keeps the repo-pinned ones (see `ruleLine`).
 */
export function liveRules(rules: OdinRule[], checkout: string): OdinRule[] {
	// action=set merges raw JSON into the store, so read the repos leniently too.
	return rules
		.map(withRepos)
		.filter(
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
export const ruleLine = (r: OdinRule) =>
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

/** A rule about pull requests - the one situation a hook can see happen. */
const PR_RULE = /pull request|\bPRs?\b|\bpush/i;

/** Single-quote for sh. */
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * What the rule hooks print, as Claude reads a hook's answer: `pr` after a
 * Bash call that opens or pushes to a PR (only the PR rules), `turn` when a
 * prompt is sent (every live rule). A prompt line alone is advice the agent
 * forgets a few turns in, and a session started or resumed with no prompt
 * never had the line at all, so every turn hands the rules back.
 */
export interface RuleHooks {
	pr: string | null;
	turn: string | null;
}

const hookOutput = (event: string, lines: string[]) =>
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: event,
			additionalContext: lines.join("\n"),
		},
	});

/** The rule hooks' answers for a session in `checkout` - null when there are no live rules. */
export function ruleHooks(rules: OdinRule[], checkout = ""): RuleHooks | null {
	const live = liveRules(rules, checkout);
	if (live.length === 0) return null;
	const pr = live.filter((r) => PR_RULE.test(r.when));
	return {
		pr: pr.length
			? hookOutput("PostToolUse", [PR_RULES_HEADER, ...pr.map(ruleLine)])
			: null,
		turn: hookOutput("UserPromptSubmit", [RULES_HEADER, ...live.map(ruleLine)]),
	};
}

/**
 * `claude --settings` JSON with the rule hooks: the PR rules after every Bash
 * call that opens or pushes to a PR, every rule on every prompt. Null when no
 * rule is live. A remote session can't take a second --settings (the host's
 * own hooks hold that flag), so it gets `ruleHooks` and the host's hooks print them.
 */
export function rulesSettings(rules: OdinRule[], checkout = ""): string | null {
	const hooks = ruleHooks(rules, checkout);
	if (!hooks) return null;
	const print = (output: string) => `printf '%s' ${sh(output)}`;
	return JSON.stringify({
		hooks: {
			UserPromptSubmit: [
				{ hooks: [{ type: "command", command: print(hooks.turn ?? "") }] },
			],
			...(hooks.pr && {
				PostToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{
								type: "command",
								command: `grep -qE ${sh(PR_COMMAND)} && ${print(hooks.pr)}; exit 0`,
							},
						],
					},
				],
			}),
		},
	});
}
