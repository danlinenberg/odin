import { refs, titleKey } from "../board/duplicates";
import type { AllItem } from "./all-items";

/**
 * The row that stands for a merged task: the source that owns the work comes
 * first - a ticket over the Notion page that copied it over the Slack message
 * that asked about it.
 */
const OWNER: AllItem["source"][] = [
	"Jira",
	"GitHub",
	"ClickUp",
	"Notion",
	"Tasks",
	"Slack",
	"Email",
];

/**
 * Bodies that point at the work rather than describe it: a Slack message, a
 * Notion inbox copy, a mail or my own note linking a ticket is about it. A
 * ticket or PR description cites other tickets in passing, so it never links.
 */
const POINTERS = new Set<AllItem["source"]>([
	"Slack",
	"Notion",
	"Email",
	"Tasks",
]);

function signals(item: AllItem): string[] {
	const title = titleKey(item.title);
	return [
		...refs(
			item.title,
			item.url,
			POINTERS.has(item.source) ? item.body : null,
		).map((ref) => `ref:${ref}`),
		...(title ? [`title:${title}`] : []),
	];
}

/**
 * The same task reaching Tasks from more than one feed - a Jira ticket, the
 * Notion page that copied it, the Slack thread asking about it - folded into
 * one row. The owner's row stays, and the others ride along in `also`, so the
 * row links every source and Done puts them all away.
 *
 * Same task: a shared Jira key or PR link, or the same title once the key
 * prefix, case and punctuation are dropped (four words or more). Two rows from
 * one source never merge: a feed already lists each of its tasks once.
 *
 * ponytail: exact refs and titles, like Next in line's duplicate check. A
 * reworded copy stays its own row.
 */
export function mergeDuplicates(items: AllItem[]): AllItem[] {
	// Union-find over rows that share a signal.
	const parent = items.map((_, i) => i);
	const root = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const sourcesOf = new Map<number, Set<AllItem["source"]>>(
		items.map((item, i) => [i, new Set([item.source])]),
	);
	const firstWith = new Map<string, number>();
	items.forEach((item, i) => {
		for (const signal of signals(item)) {
			const other = firstWith.get(signal);
			if (other === undefined) {
				firstWith.set(signal, i);
				continue;
			}
			const a = root(i);
			const b = root(other);
			if (a === b) continue;
			const sa = sourcesOf.get(a) ?? new Set();
			const sb = sourcesOf.get(b) ?? new Set();
			if ([...sa].some((source) => sb.has(source))) continue;
			parent[a] = b;
			sourcesOf.set(b, new Set([...sa, ...sb]));
		}
	});

	const groups = new Map<number, AllItem[]>();
	items.forEach((item, i) => {
		const group = groups.get(root(i)) ?? [];
		group.push(item);
		groups.set(root(i), group);
	});

	// The merged row takes the place of the group's first row.
	const out: AllItem[] = [];
	const placed = new Set<number>();
	items.forEach((item, i) => {
		const group = groups.get(root(i)) ?? [item];
		if (group.length === 1) {
			out.push(item);
			return;
		}
		if (placed.has(root(i))) return;
		placed.add(root(i));
		const [owner, ...also] = [...group].sort(
			(a, b) => OWNER.indexOf(a.source) - OWNER.indexOf(b.source),
		);
		out.push({
			...owner,
			also,
			details: [
				...owner.details,
				...also.map((copy): [string, string] => [
					`Also in ${copy.source}`,
					copy.url ?? copy.title,
				]),
			],
		});
	});
	return out;
}
