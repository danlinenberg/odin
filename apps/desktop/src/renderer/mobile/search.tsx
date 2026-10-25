import { useEffect, useState } from "react";
import type { IconType } from "react-icons";
import {
	LuCheck,
	LuLoaderCircle,
	LuRotateCcw,
	LuSearch,
	LuX,
} from "react-icons/lu";
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

/**
 * The board's own sessions whose title, contact or repo has every typed word:
 * shown at each keystroke, with no round trip, until the Mac's search (every
 * session's conversation) answers for what's typed.
 */
export function titleMatches(
	sessions: {
		paneId: string;
		title: string;
		contact?: string | null;
		repo?: string | null;
		statusAt?: number | null;
		column: PaneStatus;
	}[],
	query: string,
): SearchHit[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return sessions
		.filter((session) => {
			const text =
				`${session.title} ${session.contact ?? ""} ${session.repo ?? ""}`.toLowerCase();
			return words.every((word) => text.includes(word));
		})
		.map((session) => ({
			sessionId: session.paneId,
			paneId: session.paneId,
			title: session.title,
			snippet: "",
			person: session.contact ?? null,
			updatedAt: session.statusAt ?? 0,
			status: session.column,
		}))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

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

/**
 * What the search found: one row per session, its best line under its title.
 * A session on the board has Done, which puts it away; one off the board
 * (Done, or closed) has Resume, which puts it back.
 */
export function SearchResults({
	hits,
	loading,
	onResume,
	resuming,
	onDone,
	finishing,
}: {
	hits: SearchHit[] | undefined;
	loading: boolean;
	onResume: (hit: SearchHit) => void;
	/** The session a Resume is starting, if any. */
	resuming: string | null;
	onDone: (paneId: string) => void;
	/** The session a Done is putting away, if any. */
	finishing: string | null;
}) {
	if (loading && !hits?.length)
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
							{hit.updatedAt > 0 && (
								<span className="shrink-0 text-[12px] text-faint-foreground">
									{ago(hit.updatedAt)}
								</span>
							)}
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
								Not on the board
							</div>
						)}
					</>
				);
				return (
					<li key={hit.sessionId} className="border-b border-border">
						{hit.paneId ? (
							<div className="flex items-center gap-3 pr-4">
								<a
									href={`#/s/${hit.paneId}`}
									className="block min-w-0 flex-1 py-2.5 pl-4"
								>
									{body}
								</a>
								<HitButton
									icon={LuCheck}
									label="Done"
									busy={finishing === hit.paneId}
									disabled={finishing !== null}
									onClick={() => hit.paneId && onDone(hit.paneId)}
								/>
							</div>
						) : (
							<div className="flex items-center gap-3 px-4 py-2.5">
								<div className="min-w-0 flex-1 opacity-70">{body}</div>
								<HitButton
									icon={LuRotateCcw}
									label="Resume"
									busy={resuming === hit.sessionId}
									disabled={resuming !== null}
									onClick={() => onResume(hit)}
								/>
							</div>
						)}
					</li>
				);
			})}
			{loading && (
				<li className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted-foreground">
					<LuLoaderCircle className="size-3.5 animate-spin" />
					Searching every conversation
				</li>
			)}
		</ul>
	);
}

/** A search hit's one action: Done on a board session, Resume off it. */
function HitButton({
	icon: Icon,
	label,
	busy,
	disabled,
	onClick,
}: {
	icon: IconType;
	label: string;
	busy: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] font-medium text-primary disabled:opacity-50"
		>
			{busy ? (
				<LuLoaderCircle className="size-3.5 animate-spin" />
			) : (
				<Icon className="size-3.5" />
			)}
			{label}
		</button>
	);
}
