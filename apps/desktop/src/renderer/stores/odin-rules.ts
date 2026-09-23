import { create } from "zustand";
import { persist } from "zustand/middleware";

/** "When <when>, <action>" — a standing instruction for every session Odin starts. */
export interface OdinRule {
	id: string;
	when: string;
	action: string;
	paused?: boolean;
}

interface OdinRulesState {
	rules: OdinRule[];
	add: (when: string, action: string) => void;
	update: (id: string, patch: Partial<Omit<OdinRule, "id">>) => void;
	remove: (id: string) => void;
}

/**
 * Automations → Rules: what an agent should do when a situation comes up
 * ("when you open a PR, run /pr-iterate").
 *
 * Rules are handed to the agent in its launch prompt, not watched for by Odin.
 * The agent is the one that opens the PR, so it's the one that knows it just
 * did — Odin polling GitHub for it would learn a minute later, from outside,
 * and then have to start a second session to act on something the first one
 * could have finished itself.
 *
 * ponytail: one global list, not per profile — add `profileId` the day a rule
 * should only apply to work or personal sessions.
 */
export const useOdinRules = create<OdinRulesState>()(
	persist(
		(set) => ({
			rules: [],
			add: (when, action) => {
				if (!when.trim() || !action.trim()) return;
				set((s) => ({
					rules: [
						...s.rules,
						{ id: crypto.randomUUID(), when: when.trim(), action: action.trim() },
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

/** The rules as prompt lines — nothing when there are none switched on. */
export function rulesPrompt(rules: OdinRule[]): string[] {
	const live = rules.filter((r) => !r.paused && r.when && r.action);
	if (live.length === 0) return [];
	return [
		"",
		"Standing rules — follow each one whenever its situation comes up during this session, without being asked:",
		...live.map((r) => `- When ${r.when}: ${r.action}`),
	];
}
