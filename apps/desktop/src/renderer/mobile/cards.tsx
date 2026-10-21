import { useState } from "react";
import type { IconType } from "react-icons";
import {
	LuCheck,
	LuChevronDown,
	LuChevronRight,
	LuCloud,
	LuFileText,
	LuFolderGit2,
	LuGitPullRequest,
	LuHash,
	LuStar,
	LuTag,
	LuTicket,
	LuUser,
} from "react-icons/lu";
import type { ActiveSession } from "shared/active-sessions";
import type { PaneStatus } from "shared/tabs-types";

/** An older Odin on the Mac sends sessions without these. */
type Session = Omit<ActiveSession, "starred" | "statusAt"> &
	Partial<Pick<ActiveSession, "starred" | "statusAt">>;

const STATUS: Record<PaneStatus, { color: string; label: string }> = {
	permission: { color: "var(--attention)", label: "Needs you" },
	working: { color: "var(--working)", label: "Working" },
	review: { color: "var(--success)", label: "Final Review" },
	idle: { color: "var(--faint-foreground)", label: "Idle" },
	failed: { color: "var(--danger)", label: "Failed" },
};
const ORDER: PaneStatus[] = ["permission", "working", "review", "idle"];

/** The board's "just done" window: a turn that ended this recently is news. */
const JUST_DONE_MS = 10 * 60_000;

/** What an empty column says - every column shows, as the desktop board's do. */
const EMPTY: Record<PaneStatus, string> = {
	permission: "Nothing needs you.",
	working: "Nothing running.",
	review: "Nothing waiting for a final look.",
	idle: "No idle sessions.",
	failed: "",
};

/**
 * The board's sections: every column - Needs you, Working, Final Review,
 * Idle - empty or not, with starred sessions at the top of their own column.
 */
export function boardSections(sessions: Session[]) {
	return ORDER.map((column) => ({
		key: column,
		label: STATUS[column].label,
		rows: sessions
			.filter((s) => s.column === column)
			// Stable: within starred and unstarred, the Mac's order stays.
			.sort((a, b) => Number(!!b.starred) - Number(!!a.starred)),
		empty: EMPTY[column],
	}));
}

type DoneRow = {
	key: string;
	title: string;
	source: string;
	url: string | null;
	at: number;
};

/**
 * The All page's Done shelf: what you put away as Done, newest first. Folded
 * until you open it - it's history, not work.
 */
export function DoneShelf({ rows }: { rows: DoneRow[] }) {
	const [open, setOpen] = useState(false);
	if (rows.length === 0) return null;
	const Chevron = open ? LuChevronDown : LuChevronRight;
	return (
		<section>
			<button
				type="button"
				onClick={() => setOpen((shown) => !shown)}
				className="flex w-full items-center gap-1 px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground"
			>
				<Chevron className="size-3.5" />
				Done · {rows.length}
			</button>
			{open &&
				rows.map((row) => {
					const body = (
						<>
							<div className="line-clamp-2 text-[15px] text-soft-foreground">
								{row.title}
							</div>
							<div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
								<LuCheck className="size-3.5 text-success" />
								<span className="truncate">{row.source}</span>
								<span className="ml-auto shrink-0">{ago(row.at)}</span>
							</div>
						</>
					);
					const style =
						"mx-3 my-1.5 block rounded-[10px] border border-border bg-card/60 px-3 py-2.5";
					return row.url ? (
						<a
							key={row.key}
							href={row.url}
							target="_blank"
							rel="noreferrer"
							className={`${style} active:bg-accent`}
						>
							{body}
						</a>
					) : (
						<div key={row.key} className={style}>
							{body}
						</div>
					);
				})}
		</section>
	);
}

/** "now", "5m", "2h", "3d" since a time. */
export function ago(at: number, now = Date.now()): string {
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function Dot({ status }: { status: PaneStatus }) {
	return (
		<span
			className="inline-block size-2 shrink-0 rounded-full"
			style={{ background: STATUS[status].color }}
		/>
	);
}

export { STATUS };

/** A source the card names: the feed it came from. */
const SOURCES: Partial<Record<string, { icon: IconType; label: string }>> = {
	slack: { icon: LuHash, label: "Slack" },
	reactions: { icon: LuHash, label: "Slack" },
	jira: { icon: LuTicket, label: "Jira" },
	pr: { icon: LuGitPullRequest, label: "PR" },
	notion: { icon: LuFileText, label: "Notion" },
};

export type Details = {
	contact?: string | null;
	source?: string;
	remote?: string | null;
	tags?: string[];
	repo?: string | null;
};

/**
 * What the desktop card shows beside its title: who it's for, the feed it
 * came from, the remote host it runs on, the repo and its tags.
 */
export function Chips({ details }: { details: Details }) {
	const source = details.source ? SOURCES[details.source] : undefined;
	const chips = [
		details.contact && { icon: LuUser, label: details.contact },
		source,
		details.remote && { icon: LuCloud, label: details.remote },
		details.repo && { icon: LuFolderGit2, label: details.repo },
		...(details.tags ?? []).map((tag) => ({ icon: LuTag, label: tag })),
	].filter((chip): chip is { icon: IconType; label: string } => !!chip);
	if (!chips.length) return null;
	return (
		<span className="flex min-w-0 flex-wrap items-center gap-1">
			{chips.map(({ icon: Icon, label }) => (
				<span
					key={label}
					className="flex max-w-[12rem] items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-soft-foreground"
				>
					<Icon className="size-3 shrink-0" />
					<span className="truncate">{label}</span>
				</span>
			))}
		</span>
	);
}

/**
 * One session on the board: its column's dot, the title (two lines), where
 * it runs and how long since its status changed, a Just done pill for a turn
 * that ended in the last 10 minutes, and its star.
 */
export function SessionCard({
	session,
	onStar,
}: {
	session: Session;
	onStar: (starred: boolean) => void;
}) {
	const column = session.column as PaneStatus;
	const at = session.statusAt ?? null;
	const justDone =
		column === "review" && at !== null && Date.now() - at < JUST_DONE_MS;
	return (
		<div className="mx-3 my-1.5 flex rounded-[10px] border border-border bg-card">
			<a
				href={`#/s/${session.paneId}`}
				className="min-w-0 flex-1 rounded-l-[10px] py-2.5 pl-3 active:bg-accent"
			>
				<div className="flex items-start gap-2 text-[15px] font-semibold leading-snug">
					<span className="mt-[7px]">
						<Dot status={column} />
					</span>
					<span className="line-clamp-2">{session.title}</span>
				</div>
				<div className="mt-1 flex items-center gap-2 pl-4 text-xs text-muted-foreground">
					{justDone && (
						<span className="shrink-0 rounded-full bg-success/20 px-2 py-0.5 text-[11px] font-semibold text-success-ink">
							Just done
						</span>
					)}
					<Chips details={session} />
					{at !== null && <span className="ml-auto shrink-0">{ago(at)}</span>}
				</div>
			</a>
			<button
				type="button"
				aria-label={session.starred ? "Unstar" : "Star"}
				onClick={() => onStar(!session.starred)}
				className={`flex w-11 shrink-0 items-center justify-center ${session.starred ? "text-attention" : "text-faint-foreground"}`}
			>
				<LuStar
					className={`size-[18px] ${session.starred ? "fill-current" : ""}`}
				/>
			</button>
		</div>
	);
}
