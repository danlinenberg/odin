import { create } from "zustand";
import { persist } from "zustand/middleware";

/** "When <when>, <action>" — a standing instruction for every session Odin starts. */
export interface OdinRule {
	id: string;
	when: string;
	action: string;
	paused?: boolean;
	/** Only sessions in this checkout get it — unset means every session. */
	repo?: string;
	/** Flip `repo`: every session EXCEPT the ones in that checkout. */
	exclude?: boolean;
}

interface OdinRulesState {
	rules: OdinRule[];
	add: (when: string, action: string, repo?: string, exclude?: boolean) => void;
	update: (id: string, patch: Partial<Omit<OdinRule, "id">>) => void;
	remove: (id: string) => void;
}

/**
 * Automations → Rules: what an agent should do when a situation comes up
 * ("when you open a PR, run /pr-iterate").
 *
 * Rules are handed to the agent in its launch prompt, not watched for by Odin.
 * A prompt line alone is advice the agent forgets by its third push, so the
 * PR rules also ride on a Claude hook (`rulesSettings`) that re-reads them to
 * the agent the moment it opens or pushes to a PR.
 * The agent is the one that opens the PR, so it's the one that knows it just
 * did — Odin polling GitHub for it would learn a minute later, from outside,
 * and then have to start a second session to act on something the first one
 * could have finished itself.
 *
 * A rule can be pinned to one repo, or to every repo but one. A session whose
 * checkout rules it out never hears it; one whose checkout isn't known yet (a
 * feed launch, where the agent picks the repo) gets it with the repo named,
 * and applies it — or skips it — there.
 *
 * ponytail: one global list, not per profile — add `profileId` the day a rule
 * should only apply to work or personal sessions.
 */
export const useOdinRules = create<OdinRulesState>()(
	persist(
		(set) => ({
			rules: [],
			add: (when, action, repo, exclude) => {
				if (!when.trim() || !action.trim()) return;
				set((s) => ({
					rules: [
						...s.rules,
						{
							id: crypto.randomUUID(),
							when: when.trim(),
							action: action.trim(),
							...(repo ? { repo, ...(exclude ? { exclude } : {}) } : {}),
						},
					],
				}));
			},
			update: (id, patch) =>
				set((s) => ({
					rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
				})),
			remove: (id) =>
				set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),
		}),
		{ name: "odin-rules" },
	),
);

/**
 * The switched-on rules that reach a session in `checkout` — "" when the
 * checkout isn't known, which keeps the repo-pinned ones (see `ruleLine`).
 */
function liveRules(rules: OdinRule[], checkout: string): OdinRule[] {
	return rules.filter(
		(r) =>
			!r.paused &&
			r.when &&
			r.action &&
			(!r.repo || !checkout || inRepo(checkout, r.repo) !== !!r.exclude),
	);
}

const inRepo = (checkout: string, repo: string) =>
	checkout === repo || checkout.startsWith(`${repo}/`);

/** One rule as the agent reads it — the repo named when it's pinned to one. */
const ruleLine = (r: OdinRule) =>
	`- When ${r.when}${r.repo ? ` (${r.exclude ? "except" : "only"} in the repo at ${r.repo})` : ""}: ${r.action}`;

/** The rules as prompt lines — nothing when there are none switched on. */
export function rulesPrompt(rules: OdinRule[], checkout = ""): string[] {
	const live = liveRules(rules, checkout);
	if (live.length === 0) return [];
	return [
		"",
		"Standing rules — follow each one whenever its situation comes up during this session, without being asked:",
		...live.map(ruleLine),
	];
}

/** A rule about pull requests — the only situation a hook can see happen. */
const PR_RULE = /pull request|\bPRs?\b|\bpush/i;

/**
 * Bash calls that open or change a PR. Matched against the whole hook input,
 * so the command itself — Claude's PostToolUse payload carries it verbatim.
 */
const PR_COMMAND = "gh pr (create|edit|ready)|git push";

/** Single-quote for sh. */
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * `claude --settings` JSON that fires the PR rules after every Bash call that
 * opens or pushes to a PR — every time the PR changes, not just the first.
 * Null when no live rule is about PRs.
 *
 * ponytail: a grep over the hook payload, not a parse of tool_input — a
 * command that merely prints "git push" fires it too, which costs one
 * redundant reminder.
 */
export function rulesSettings(rules: OdinRule[], checkout = ""): string | null {
	const live = liveRules(rules, checkout).filter((r) => PR_RULE.test(r.when));
	if (live.length === 0) return null;
	const context = [
		"You just opened or pushed to a pull request. Do these now, before anything else — again on every later push to it:",
		...live.map(ruleLine),
	].join("\n");
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
