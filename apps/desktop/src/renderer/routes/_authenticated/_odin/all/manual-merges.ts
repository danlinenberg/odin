import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AllItem } from "./all-items";
import { OWNER } from "./merge-duplicates";

/**
 * Tasks you merged into one by hand: tick two or more rows, Merge. Each group
 * is row keys, the one that stays first. Like the automatic merge of the same
 * task across feeds, the others ride along in the row's `also` - a chip per
 * source that opens it, Done and Drop put them all away - but any rows can be
 * merged, two from one feed included. Nothing upstream changes, and Split
 * brings every row back as it was.
 */
export const useManualMerges = create<{
	groups: string[][];
	merge: (keys: string[]) => void;
	/** Take the group this row heads apart again. */
	split: (key: string) => void;
}>()(
	persist(
		(set) => ({
			groups: [],
			merge: (keys) =>
				set((state) => {
					// A row already in a group brings its group along: merging a
					// merged row with another makes one bigger group.
					const joined = state.groups.filter((group) =>
						group.some((key) => keys.includes(key)),
					);
					const merged = [...new Set([...keys, ...joined.flat()])];
					return {
						// Bounded: the newest 300 groups.
						groups: [
							...state.groups.filter((group) => !joined.includes(group)),
							merged,
						].slice(-300),
					};
				}),
			split: (key) =>
				set((state) => ({
					groups: state.groups.filter((group) => group[0] !== key),
				})),
		}),
		{ name: "odin-task-merges" },
	),
);

/**
 * Which ticked row stays: the source that owns the work (a ticket over the
 * Slack message about it, as the automatic merge picks), and among rows from
 * one source the first one listed.
 */
export function mergeOrder(items: readonly AllItem[]): string[] {
	return items
		.map((item, i) => ({ item, i }))
		.sort(
			(a, b) =>
				OWNER.indexOf(a.item.source) - OWNER.indexOf(b.item.source) ||
				a.i - b.i,
		)
		.map(({ item }) => item.key);
}

/**
 * Merge ticked rows into one, the owner first (mergeOrder). Returns the Undo
 * that puts the merges back as they were, or null with fewer than two rows.
 */
export function mergeTicked(items: readonly AllItem[]): (() => void) | null {
	const keys = mergeOrder(items);
	if (keys.length < 2) return null;
	const before = useManualMerges.getState().groups;
	useManualMerges.getState().merge(keys);
	return () => useManualMerges.setState({ groups: before });
}

/** One entry per merged-in task for the session's brief: what, where, your notes. */
function mergedBrief(
	also: readonly AllItem[],
	notes: Readonly<Record<string, string>>,
): string {
	const indent = (text: string) => `  ${text.replaceAll("\n", "\n  ")}`;
	return [
		"Merged into this task:",
		...also.map((copy) => {
			const note = notes[copy.key];
			return [
				`- ${copy.source}: ${copy.title}${copy.url ? ` (${copy.url})` : ""}`,
				copy.launch.description && indent(copy.launch.description),
				note && indent(`My notes: ${note}`),
			]
				.filter(Boolean)
				.join("\n");
		}),
	].join("\n");
}

const alsoIn = (copy: AllItem): [string, string] => [
	`Also in ${copy.source}`,
	copy.url ?? copy.title,
];

/**
 * Fold each merged group into its first row still listed. A group with fewer
 * than two rows listed (the rest done or gone) leaves its row alone. The
 * merged row keeps every source's link (its `also` and "Also in" details),
 * and Start hands the agent all of them with your notes on each.
 */
export function applyManualMerges(
	items: readonly AllItem[],
	groups: readonly string[][],
	notes: Readonly<Record<string, string>> = {},
): AllItem[] {
	if (groups.length === 0) return [...items];
	const byKey = new Map(items.map((item) => [item.key, item]));
	const into = new Map<string, AllItem[]>();
	const folded = new Set<string>();
	for (const group of groups) {
		const listed = group.flatMap((key) => {
			const item = byKey.get(key);
			return item && !folded.has(key) && !into.has(key) ? [item] : [];
		});
		if (listed.length < 2) continue;
		const [head, ...rest] = listed;
		into.set(head.key, rest);
		for (const item of rest) folded.add(item.key);
	}
	return items.flatMap((item) => {
		if (folded.has(item.key)) return [];
		const rest = into.get(item.key);
		if (!rest) return [item];
		// The rows folded in, and the copies each already carried.
		const carried = rest.flatMap((copy) => copy.also ?? []);
		return [
			{
				...item,
				also: [
					...(item.also ?? []),
					...rest.map((copy) => ({ ...copy, also: undefined })),
					...carried,
				],
				merged: true,
				details: [...item.details, ...rest.map(alsoIn), ...carried.map(alsoIn)],
				launch: {
					...item.launch,
					description: [item.launch.description, mergedBrief(rest, notes)]
						.filter(Boolean)
						.join("\n\n"),
				},
			},
		];
	});
}
