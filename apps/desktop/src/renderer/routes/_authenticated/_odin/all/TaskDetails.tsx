import type { ReactNode } from "react";
import { emojify } from "renderer/lib/emoji";
import { FEED_TABS } from "../components/feed-counts";
import type { AllItem } from "./all-items";

export function cleanTitle(title: string): string {
	return title.replace(/[*~]/g, "").replace(/\s+/g, " ").trim();
}

const ICON = Object.fromEntries(FEED_TABS.map(({ to, Icon }) => [to, Icon]));

/**
 * A task in full - the whole Slack message, not the line it was cut to - and
 * everything its row had to leave out: every field the source sent, the
 * comment that put it here, and the link itself. Next in line's hover card and
 * the Tasks page's side panel both draw it, so a row reads the same in each.
 */
export function TaskDetails({
	item,
	extraRows = [],
	children,
}: {
	item: AllItem;
	/** Fields only the caller knows - Next in line's due date and AI rank. */
	extraRows?: [string, string][];
	/** Drawn after the fields - Next in line's Review sweep verdict. */
	children?: ReactNode;
}) {
	const Icon = ICON[item.to];
	const rows: [string, string][] = [...item.details];
	for (const row of extraRows) {
		if (!rows.some(([label]) => label === row[0])) rows.push(row);
	}
	const body = item.body?.trim();
	return (
		<div className="space-y-2.5 text-[12px] leading-[1.5]">
			<div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
				{Icon && <Icon className="size-3 shrink-0" aria-hidden />}
				<span className="font-medium text-muted-foreground">{item.source}</span>
				{item.priority && <span>· {item.priority}</span>}
				{item.status && <span>· {item.status}</span>}
			</div>
			<p
				dir="auto"
				className="break-words text-left font-semibold text-foreground"
			>
				{emojify(cleanTitle(item.title))}
			</p>
			{body && body !== item.title.trim() && (
				<p
					dir="auto"
					className="max-h-[220px] cursor-text select-text overflow-y-auto whitespace-pre-wrap break-words text-left text-soft-foreground"
				>
					{emojify(body.slice(0, 3000))}
				</p>
			)}
			{item.mention && (
				<div className="rounded-md border-l-2 border-primary bg-primary/8 px-2 py-1.5 text-soft-foreground">
					{item.mention.author && (
						<div className="text-[11px] font-medium text-primary">
							{item.mention.author}
						</div>
					)}
					<div
						dir="auto"
						className="line-clamp-6 whitespace-pre-wrap break-words"
					>
						{emojify(item.mention.text)}
					</div>
				</div>
			)}
			{rows.length > 0 && (
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
					{rows.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-muted-foreground">{label}</dt>
							<dd
								dir="auto"
								className="min-w-0 break-words text-soft-foreground"
							>
								{value}
							</dd>
						</div>
					))}
				</dl>
			)}
			{children}
			{item.url && (
				<div className="cursor-text select-text truncate text-[11px] text-faint-foreground">
					{item.url}
				</div>
			)}
		</div>
	);
}
