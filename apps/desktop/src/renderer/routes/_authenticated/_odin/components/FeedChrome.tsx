import { cn } from "@odin/ui/utils";
import type { ReactNode } from "react";
import { FeedTabs } from "./FeedTabs";

/**
 * One header row per feed. Every view used to stack two bars — the sources on
 * top, its own filters underneath — which read as two competing tab strips
 * over a list. They're one row now: sources, a hairline, this feed's filters,
 * then its tools on the right.
 */
export function FeedHeader({ children }: { children?: ReactNode }) {
	return (
		<div className="flex items-center gap-2.5 border-b border-[#25252e] px-[18px] py-2.5">
			<FeedTabs />
			{children}
		</div>
	);
}

/**
 * Break between the source strip and a feed's own filters. It was a hairline in
 * the header's own border colour with 10px of gap either side — which read as
 * one continuous row of ten pills. Brighter, taller, and set further apart, so
 * "which source" and "which status" land as two groups at a glance.
 */
export function FeedDivider() {
	return <span className="mx-2 h-5 w-px shrink-0 bg-[#3c3c4a]" />;
}

/**
 * A feed's own filter. Deliberately quieter than the source strip next to it —
 * same row, second rank.
 */
export function FilterPill({
	active,
	count,
	onClick,
	children,
}: {
	active: boolean;
	count?: number;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
				active
					? "bg-[#1f1f27] text-[#f5f5f7]"
					: "text-[#8a8a97] hover:text-[#f5f5f7]",
			)}
		>
			{children}
			{count !== undefined && (
				<span
					className={cn(
						"rounded-[10px] px-1.5 text-[11px] tabular-nums",
						active ? "bg-[#2b2b36] text-[#a5a5b3]" : "bg-[#1f1f27]",
					)}
				>
					{count > 99 ? "99+" : count}
				</span>
			)}
		</button>
	);
}

/**
 * A feed's "narrow it down" picker — repo, project, channel, priority. A
 * select rather than more pills because the options are the data's, not the
 * app's: there can be two of them or forty.
 */
export function FeedSelect({
	value,
	onChange,
	title,
	children,
}: {
	value: string;
	onChange: (value: string) => void;
	title: string;
	children: ReactNode;
}) {
	return (
		<select
			value={value}
			onChange={(e) => onChange(e.target.value)}
			title={title}
			className={cn(
				"max-w-[180px] cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium outline-none",
				value
					? "border-[#a394ff] bg-[#211d3a] text-[#f5f5f7]"
					: "border-[#25252e] bg-[#16161b] text-[#a5a5b3] hover:text-[#f5f5f7]",
			)}
		>
			{children}
		</select>
	);
}

/** Refresh every feed, not just this one — same button in each view. */
export function SyncButton({
	isSyncing,
	onClick,
}: {
	isSyncing: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={isSyncing}
			title="Refresh Slack, Jira, GitHub and Notion"
			className="shrink-0 rounded-[7px] bg-[#1f1f27] px-2.5 py-1 text-[12px] font-medium text-[#a5a5b3] transition-colors hover:text-[#f5f5f7] disabled:opacity-40"
		>
			{isSyncing ? "syncing…" : "↻ Sync"}
		</button>
	);
}

/**
 * Row actions that only matter once you're pointing at the row: hidden until
 * hover (or keyboard focus), so a long list is titles rather than buttons.
 * Put the primary action outside this — it stays visible.
 */
export function RowActions({ children }: { children: ReactNode }) {
	return (
		<span className="flex items-center gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
			{children}
		</span>
	);
}

/**
 * The primary "do the thing" button on a row: calm down the page by default,
 * bright on the row you're actually pointing at.
 */
export const ROW_PRIMARY_BUTTON =
	"shrink-0 rounded-[7px] bg-[#1f1f27] px-3 py-1 text-xs font-semibold text-[#a394ff] transition-colors group-hover:bg-[#a394ff] group-hover:text-[#131126] disabled:opacity-40";

/** Same, for a row whose session is live — green rather than purple. */
export const ROW_LIVE_BUTTON =
	"shrink-0 rounded-[7px] bg-[#14301f] px-3 py-1 text-xs font-semibold text-[#3ecf8e] transition-colors hover:bg-[#1a3d28]";

/** Low-signal row metadata — a date, a project key. Text, not another chip. */
export const ROW_META = "text-[11px] text-[#8a8a97]";

/**
 * Fixed-width meta columns, shared by every feed so they all read the same
 * way. A slot keeps its width with nothing in it: the name, the status and
 * the date line up down the whole list instead of drifting with the length
 * of the title above them.
 */
export const META_PERSON =
	"flex w-[160px] shrink-0 items-center overflow-hidden";
/** A short chip — live, priority, why this row is here. */
export const META_TAG = "flex w-[62px] shrink-0 items-center overflow-hidden";
/** A status chip, which can run as long as "Discovery & Scoping". */
export const META_STATUS =
	"flex w-[116px] shrink-0 items-center overflow-hidden";
/** Plain text — the project, the repo, the channel. */
export const META_TEXT =
	"w-[132px] shrink-0 truncate text-[11px] text-[#8a8a97]";
export const META_DATE = "w-[48px] shrink-0 text-[11px] text-[#8a8a97]";

/**
 * "Open it where it lives" — on the row rather than under a hover, because
 * reading the thread, the ticket or the PR is half of what a queue is for.
 * The slot keeps its width for rows that have no link.
 */
export const ROW_LINK_SLOT = "flex w-[84px] shrink-0 justify-end";
/**
 * The primary button sits in a fixed slot too: "Go to session →" is wider
 * than "Start session", and without one it drags every column on the row
 * left with it.
 */
export const ROW_PRIMARY_SLOT = "flex w-[132px] shrink-0 justify-end";
export const ROW_LINK_BUTTON =
	"whitespace-nowrap rounded-[7px] px-2.5 py-1 text-xs font-semibold text-[#8a8a97] transition-colors hover:bg-[#211d3a] hover:text-[#a394ff]";

/**
 * The scroller under a header, one row in it, and a notice in the same stack.
 * Every feed grew its own gutter, row padding and gap — 4px here, 6px there —
 * which read as a different app per tab. One set of numbers, shared.
 */
export const FEED_LIST =
	"flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-[18px] pb-[18px] pt-2";
export const FEED_ROW =
	"group rounded-[10px] border border-[#25252e] bg-[#111114] px-3.5 py-2";
/** A full-width box in the list — not connected, nothing picked, failed. */
export const FEED_NOTICE_BOX = "rounded-[10px] px-3.5 py-2.5 text-xs";
