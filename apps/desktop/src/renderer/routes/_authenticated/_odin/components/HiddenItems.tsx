import { cn } from "@odin/ui/utils";
import { useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Rows I've dismissed from a feed — a Jira ticket someone else owns, a PR I'll
 * never review, a Slack thread that resolved itself. The feeds are read-only
 * mirrors of other people's systems, so hiding is Odin-local: a persisted set
 * of `feed:id` keys, reversible from the "N hidden" toggle in each view.
 */
const useHiddenItems = create<{
	hidden: Record<string, true>;
	toggle: (key: string) => void;
}>()(
	persist(
		(set) => ({
			hidden: {},
			toggle: (key) =>
				set((s) => {
					if (!s.hidden[key]) return { hidden: { ...s.hidden, [key]: true } };
					const { [key]: _, ...rest } = s.hidden;
					return { hidden: rest };
				}),
		}),
		{ name: "odin-hidden-items" },
	),
);

/**
 * Hide/show plumbing for one feed. `prefix` namespaces the keys, so the same id
 * in two feeds isn't the same row.
 *
 * Hidden rows are filtered out before counts are taken, so tabs and pills say
 * what's actually on screen — the total lives in the "N hidden" toggle.
 */
export function useHiddenFilter<T>(
	prefix: string,
	rows: T[],
	id: (row: T) => string,
) {
	const hidden = useHiddenItems((s) => s.hidden);
	const toggleKey = useHiddenItems((s) => s.toggle);
	const [showHidden, setShowHidden] = useState(false);
	const isHidden = (row: T) => hidden[`${prefix}:${id(row)}`] === true;
	return {
		rows: showHidden ? rows : rows.filter((row) => !isHidden(row)),
		hiddenCount: rows.filter(isHidden).length,
		showHidden,
		setShowHidden,
		isHidden,
		toggle: (row: T) => toggleKey(`${prefix}:${id(row)}`),
	};
}

/** Per-row dismiss — and un-dismiss, once the hidden rows are revealed. */
export function HideButton({
	hidden,
	onClick,
}: {
	hidden: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={hidden ? "Show this again" : "Hide this row"}
			className="rounded-[7px] px-2 py-1 text-xs font-semibold text-[#8a8a97] hover:bg-[#1f1f27] hover:text-[#f5f5f7]"
		>
			{hidden ? "↺" : "✕"}
		</button>
	);
}

/** "N hidden" reveal switch — nothing is hidden without a way back. */
export function HiddenToggle({
	count,
	showing,
	onToggle,
	className,
}: {
	count: number;
	showing: boolean;
	onToggle: () => void;
	className?: string;
}) {
	if (count === 0 && !showing) return null;
	return (
		<button
			type="button"
			onClick={onToggle}
			className={cn(
				"text-[12px] text-[#8a8a97] transition-colors hover:text-[#a5a5b3]",
				className,
			)}
		>
			{showing ? "hide" : "show"} hidden ({count})
		</button>
	);
}
