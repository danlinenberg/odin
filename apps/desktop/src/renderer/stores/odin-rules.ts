import type { OdinRule } from "shared/odin-rules";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export {
	type OdinRule,
	RULES_HEADER,
	rulesPrompt,
	rulesSettings,
} from "shared/odin-rules";

interface OdinRulesState {
	rules: OdinRule[];
	add: (
		when: string,
		action: string,
		repos?: string[],
		exclude?: boolean,
	) => void;
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
 * did - Odin polling GitHub for it would learn a minute later, from outside,
 * and then have to start a second session to act on something the first one
 * could have finished itself.
 *
 * A rule can be pinned to some repos, or to every repo but those. A session
 * whose checkout rules it out never hears it; one whose checkout isn't known
 * yet (a feed launch, where the agent picks the repo) gets it with the repos
 * named, and applies it - or skips it - there.
 */
export const useOdinRules = create<OdinRulesState>()(
	persist(
		(set) => ({
			rules: [],
			add: (when, action, repos, exclude) => {
				if (!when.trim() || !action.trim()) return;
				set((s) => ({
					rules: [
						...s.rules,
						{
							id: crypto.randomUUID(),
							when: when.trim(),
							action: action.trim(),
							...(repos?.length
								? { repos, ...(exclude ? { exclude } : {}) }
								: {}),
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
		{
			name: "odin-rules",
			// v0 held one `repo` per rule.
			version: 1,
			migrate: (persisted, version) =>
				migrateRules(persisted, version) as OdinRulesState,
		},
	),
);

/** Persisted state from an older version, brought up to today's shape. */
export function migrateRules(persisted: unknown, version: number): unknown {
	const state = persisted as { rules?: (OdinRule & { repo?: string })[] };
	if (version < 1 && state?.rules)
		state.rules = state.rules.map(({ repo, ...r }) =>
			repo ? { ...r, repos: [repo] } : r,
		);
	return state;
}
