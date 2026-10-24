import { useEffect, useState } from "react";
import { LuLoaderCircle, LuSearch, LuX } from "react-icons/lu";
import type { PaneStatus } from "shared/tabs-types";
import { ago, Dot, STATUS } from "./cards";

export type SearchHit = {
	sessionId: string;
	/** On the board: the session to open. Null for one that left it. */
	paneId: string | null;
	title: string;
	snippet: string;
	person: string | null;
	updatedAt: number;
	/** Its board column; null off the board, or from an older Odin on the Mac. */
	status?: PaneStatus | null;
};

/** The typed query, once typing pauses: every keystroke would rescan the logs. */
export function useSettled(value: string, ms = 350): string {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return settled;
}

/** The board's search box: every session's conversation, as the desktop's ⌘F searches it. */
export function SearchBox({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="mt-2 flex h-10 items-center gap-2 rounded-[10px] border border-input bg-secondary px-3">
			<LuSearch className="size-4 shrink-0 text-muted-foreground" />
			<input
				type="search"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder="Search sessions"
				enterKeyHint="search"
				className="min-w-0 flex-1 bg-transparent text-base outline-none"
			/>
			{value && (
				<button
					type="button"
					aria-label="Clear the search"
					onClick={() => onChange("")}
					className="flex size-7 items-center justify-center text-muted-foreground"
				>
					<LuX className="size-4" />
				</button>
			)}
		</label>
	);
}

/** What the search found: one row per session, its best line under its title. */
export function SearchResults({
	hits,
	loading,
}: {
	hits: SearchHit[] | undefined;
	loading: boolean;
}) {
	if (loading && !hits)
		return (
			<div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
				<LuLoaderCircle className="size-4 animate-spin" />
				Searching your sessions
			</div>
		);
	if (!hits?.length)
		return (
			<div className="px-4 py-6 text-sm text-muted-foreground">
				No session matches.
			</div>
		);
	return (
		<ul className="flex flex-col">
			{hits.map((hit) => {
				const body = (
					<>
						<div className="flex items-baseline gap-2">
							{hit.status && (
								<span className="shrink-0 self-start pt-[7px]">
									<Dot status={hit.status} />
								</span>
							)}
							<span className="line-clamp-2 min-w-0 flex-1 text-[15px] font-medium">
								{hit.title}
							</span>
							<span className="shrink-0 text-[12px] text-faint-foreground">
								{ago(hit.updatedAt)}
							</span>
						</div>
						{hit.snippet && (
							<div className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
								{hit.snippet}
							</div>
						)}
						{hit.status && (
							<div className="mt-0.5 text-[12px] text-muted-foreground">
								{STATUS[hit.status].label}
							</div>
						)}
						{!hit.paneId && (
							<div className="mt-0.5 text-[12px] text-faint-foreground">
								Not on the board - resume it on your Mac
							</div>
						)}
					</>
				);
				return (
					<li key={hit.sessionId} className="border-b border-border">
						{hit.paneId ? (
							<a href={`#/s/${hit.paneId}`} className="block px-4 py-2.5">
								{body}
							</a>
						) : (
							<div className="px-4 py-2.5 opacity-70">{body}</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
