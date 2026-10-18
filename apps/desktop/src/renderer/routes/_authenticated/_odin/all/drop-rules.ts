import { useEffect } from "react";
import { useDoneStore } from "renderer/stores/done";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AllItem } from "./all-items";
import { useSearchableItems } from "./use-all-items";

/**
 * "Drop tasks like this from now on": one field of one source that, when a row
 * carries it, puts the row away as Done the moment it shows up. Done, not a
 * hidden list - so every feed, badge, the sweep and the Night Agent skip it
 * the same way, and All's Done list can still bring one back.
 */
export interface DropRule {
	source: AllItem["source"];
	field: "person" | "context" | "title";
	value: string;
}

/** Plenty for hand-made rules; the oldest go first past it. */
const MAX_RULES = 200;

const FIELD_LABEL: Record<DropRule["field"], string> = {
	person: "From",
	context: "In",
	title: "Titled",
};

export function ruleLabel(rule: DropRule): string {
	return `${FIELD_LABEL[rule.field]} ${rule.value}`;
}

/** The rules a row could start: one per field it has. */
export function rulesFor(item: AllItem): DropRule[] {
	return (["person", "context", "title"] as const).flatMap((field) => {
		const value = item[field]?.trim();
		return value ? [{ source: item.source, field, value }] : [];
	});
}

export function matchesRule(item: AllItem, rule: DropRule): boolean {
	return item.source === rule.source && item[rule.field]?.trim() === rule.value;
}

const ruleId = (rule: DropRule) => `${rule.source}|${rule.field}|${rule.value}`;
const sameRule = (a: DropRule, b: DropRule) => ruleId(a) === ruleId(b);

export const useDropRules = create<{
	rules: DropRule[];
	add: (rule: DropRule) => void;
	remove: (rule: DropRule) => void;
}>()(
	persist(
		(set) => ({
			rules: [],
			add: (rule) =>
				set((state) => ({
					rules: [...state.rules.filter((r) => !sameRule(r, rule)), rule].slice(
						-MAX_RULES,
					),
				})),
			// The rows it dropped come back with it.
			remove: (rule) => {
				set((state) => ({
					rules: state.rules.filter((r) => !sameRule(r, rule)),
				}));
				const { done, setDone } = useDoneStore.getState();
				for (const [key, row] of Object.entries(done))
					if (row.rule === ruleId(rule)) setDone(key, null);
			},
		}),
		{ name: "odin.all.dropRules" },
	),
);

/**
 * Marks Done every open row a rule matches - the ones there now, and each new
 * one as its feed brings it in. Mounted once, in the Odin shell.
 */
export function useApplyDropRules() {
	const rules = useDropRules((s) => s.rules);
	const items = useSearchableItems();
	useEffect(() => {
		if (rules.length === 0) return;
		const { setDone } = useDoneStore.getState();
		for (const item of items) {
			if (item.done) continue;
			const rule = rules.find((r) => matchesRule(item, r));
			if (rule)
				setDone(item.key, {
					title: item.title,
					source: item.source,
					url: item.url,
					rule: ruleId(rule),
				});
		}
	}, [rules, items]);
}
