import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useSearchHotkey } from "../components/FeedChrome";

export const Route = createFileRoute("/_authenticated/_odin/insights/")({
	component: InsightsPage,
});

/**
 * Insights — what you got done, and what it cost you. Arithmetic over the
 * transcript store, not a model call: a summary you wait fifteen seconds for
 * is one you stop opening.
 */

const SOURCE_LABEL: Record<string, string> = {
	reactions: "Slack",
	jira: "Jira",
	pr: "GitHub",
	notion: "Notion",
};

const AGENT_COLOR = "#a394ff";
const YOU_COLOR = "#3ecf8e";
/** Plain rankings (repo, person, source) — not you vs agent, so neither hue. */
const RANK_COLOR = "#6b8fb8";

const DATE = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
});

/** "0.3h" is not a duration anyone says out loud. */
function duration(hours: number): string {
	if (hours <= 0) return "0";
	if (hours < 1) return `${Math.round(hours * 60)}m`;
	return `${Math.round(hours * 10) / 10}h`;
}

function Heading({ title, note }: { title: string; note?: string }) {
	return (
		<div className="flex items-baseline gap-2">
			<div className="text-[11px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
				{title}
			</div>
			{note && <div className="text-[11px] text-[#6f6f7d]">{note}</div>}
		</div>
	);
}

function Section({
	title,
	note,
	aside,
	children,
}: {
	title: string;
	note?: string;
	aside?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<Heading title={title} note={note} />
				{aside}
			</div>
			{children}
		</div>
	);
}

function Card({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-[10px] border border-[#25252e] bg-[#111114] p-4">
			{children}
		</div>
	);
}

function Stat({
	value,
	label,
	hint,
}: {
	value: string;
	label: string;
	hint?: string;
}) {
	return (
		<div className="flex min-w-[112px] flex-1 flex-col gap-1 rounded-[10px] border border-[#25252e] bg-[#111114] px-3.5 py-3">
			<div className="text-[22px] font-semibold leading-none text-[#f5f5f7]">
				{value}
			</div>
			<div className="text-[11.5px] text-[#a5a5b3]">{label}</div>
			{hint && <div className="text-[10.5px] text-[#6f6f7d]">{hint}</div>}
		</div>
	);
}

/**
 * A labelled bar. The track is capped rather than elastic: stretched across a
 * wide window, a bar for "5" ran the full width of the screen and stopped
 * meaning anything.
 */
function Bar({
	name,
	fraction,
	value,
	color = RANK_COLOR,
}: {
	name: string;
	/** 0–1 of the biggest row in the group. */
	fraction: number;
	value: string;
	color?: string;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<div className="w-[108px] shrink-0 truncate text-[12px] text-[#d6d6dc]">
				{name}
			</div>
			<div className="h-[6px] min-w-0 max-w-[260px] flex-1 overflow-hidden rounded-full bg-[#1b1b22]">
				<div
					className="h-full rounded-full"
					style={{
						width: `${Math.max(3, fraction * 100)}%`,
						background: color,
					}}
				/>
			</div>
			<div className="shrink-0 text-right text-[11.5px] tabular-nums text-[#a5a5b3]">
				{value}
			</div>
		</div>
	);
}

function BarGroup({
	rows,
	color,
}: {
	rows: { name: string; weight: number; value: string }[];
	color?: string;
}) {
	const max = Math.max(1, ...rows.map((row) => row.weight));
	return (
		<Card>
			<div className="flex flex-col gap-2">
				{rows.map((row) => (
					<Bar
						key={row.name}
						name={row.name}
						fraction={row.weight / max}
						value={row.value}
						color={color}
					/>
				))}
			</div>
		</Card>
	);
}

/** "1 sessions" is the kind of thing that makes a number look unread. */
function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function Spinner() {
	return (
		<span className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-[#2a2a34] border-t-[#a394ff]" />
	);
}

/** Marks a section as still loading; the page hides until none are left. */
function Loading() {
	return <div aria-busy="true" />;
}

function Empty({ children }: { children: React.ReactNode }) {
	return (
		<Card>
			<div className="text-[12px] text-[#6f6f7d]">{children}</div>
		</Card>
	);
}

/**
 * Weeks as paired columns: what the agents did against what it cost you.
 *
 * One scale for both series on purpose — the gap between the pair IS the
 * reading, and rescaling each series separately would flatten it. Only weeks
 * the transcript store actually covers are drawn.
 */
function WeekChart({
	weeks,
}: {
	weeks: {
		start: number;
		agentHours: number;
		yourHours: number;
		sessions: number;
	}[];
}) {
	const max = Math.max(1, ...weeks.map((week) => week.agentHours));
	return (
		<Card>
			<div className="flex items-end gap-3">
				{weeks.map((week) => (
					<div
						key={week.start}
						className="flex min-w-0 flex-1 flex-col items-center gap-2"
						title={`${week.sessions} sessions · ${duration(week.agentHours)} of agent work for ${duration(week.yourHours)} of yours`}
					>
						{/* justify-end so the number rides on top of its own bar
						    instead of floating at the top of an empty column. */}
						<div className="flex h-[132px] w-full flex-col items-center justify-end">
							<div className="mb-1 text-[11px] font-medium tabular-nums text-[#d6d6dc]">
								{week.agentHours > 0 ? duration(week.agentHours) : "—"}
							</div>
							<div className="flex w-full items-end justify-center gap-[4px]">
								<Column hours={week.yourHours} max={max} color={YOU_COLOR} />
								<Column hours={week.agentHours} max={max} color={AGENT_COLOR} />
							</div>
						</div>
						<div className="truncate text-[10.5px] text-[#6f6f7d]">
							{DATE.format(week.start)}
						</div>
					</div>
				))}
			</div>
		</Card>
	);
}

function Column({
	hours,
	max,
	color,
}: {
	hours: number;
	max: number;
	color: string;
}) {
	return (
		<div
			className="w-full max-w-[26px] rounded-t-[3px]"
			style={{
				// A worked week never renders as nothing: a hairline still reads as
				// "some", which a zero-height bar doesn't.
				height: hours > 0 ? `${Math.max(3, (hours / max) * 110)}px` : "2px",
				background: hours > 0 ? color : "#25252e",
			}}
		/>
	);
}

/**
 * A fixed 24-hour axis, not a list of data — starting at 06:00, so the day
 * reads left to right and the small hours sit at the end of it.
 */
const HOURS = Array.from({ length: 24 }, (_, index) => (index + 6) % 24);

/**
 * One week's hours as a grid, weekday rows by hour columns. `cells` is indexed
 * `weekday * 24 + hour`; each cell shades against the grid's busiest one.
 */
function HourGrid({
	cells,
	color,
	describe = (minutes) => `${minutes}m`,
}: {
	cells: number[] | undefined;
	color: string;
	describe?: (value: number) => string;
}) {
	const max = Math.max(1, ...(cells ?? []));
	return (
		<div
			className="grid gap-[3px]"
			style={{ gridTemplateColumns: "34px repeat(24, minmax(0, 1fr))" }}
		>
			{WEEKDAYS.map((day, weekday) => (
				<Fragment key={day}>
					<div className="pr-1.5 text-right text-[11px] leading-[24px] text-[#6f6f7d]">
						{day}
					</div>
					{HOURS.map((hour) => {
						// A row is a working day, 06:00 to 05:59 — workload.ts buckets
						// the small hours into the day before, so a row's 00–05 are
						// the next calendar day's.
						const calendarDay = hour < 6 ? (weekday + 1) % 7 : weekday;
						const value = cells?.[weekday * 24 + hour] ?? 0;
						const label = String(hour).padStart(2, "0");
						return (
							<div
								key={hour}
								className="h-[24px] rounded-[3px]"
								style={cellStyle(value, max, color)}
								title={`${WEEKDAYS[calendarDay]} ${label}:00 — ${describe(value)}`}
							/>
						);
					})}
				</Fragment>
			))}
			{/* The hour axis, sharing the grid so labels sit under their column. */}
			<div />
			{HOURS.map((hour, index) => (
				<div
					key={hour}
					className="pt-1 text-center text-[10.5px] text-[#6f6f7d]"
				>
					{index % 3 === 0 ? String(hour).padStart(2, "0") : ""}
				</div>
			))}
		</div>
	);
}

/**
 * Every recorded week folded into one grid: the shape of a typical week.
 */
function AllWeeksGrid({
	heatmap,
	color,
}: {
	heatmap: { start: number; minutes: number[] }[];
	color: string;
}) {
	const totals = useMemo(() => {
		const sum = Array.from({ length: 7 * 24 }, () => 0);
		for (const week of heatmap)
			week.minutes.forEach((minutes, cell) => {
				sum[cell] = (sum[cell] ?? 0) + minutes;
			});
		return sum;
	}, [heatmap]);
	const weeks = Math.max(1, heatmap.length);
	return (
		<Card>
			<HourGrid
				cells={totals}
				color={color}
				describe={(total) =>
					`${duration(total / 60)} across ${plural(weeks, "week")}, ${Math.round(total / weeks)}m a week`
				}
			/>
		</Card>
	);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DAY_MS = 86_400_000;

/**
 * Sunday 00:00 local. The same rule the main process buckets cells by — four
 * lines duplicated rather than imported, because that module reaches for
 * `node:fs` and can't come into the renderer.
 */
function weekStart(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() - date.getDay());
	return date.getTime();
}

/** `count` weeks from `start`, stepped as a date so DST can't drift it. */
function shiftWeeks(start: number, count: number): number {
	const date = new Date(start);
	date.setDate(date.getDate() + count * 7);
	return date.getTime();
}

/**
 * Shaded against the grid's own busiest cell, so the shape of a week reads
 * even when every hour is half-full — an absolute 60-minute scale squeezed a
 * typical week into two near-identical greens.
 */
function cellStyle(
	value: number,
	max: number,
	color: string,
): React.CSSProperties {
	if (value <= 0) return { background: "#1b1b22" };
	// Four steps rather than a continuous ramp — quantised, a cell can actually
	// be matched against its neighbours. Wide spacing so the steps are visible.
	const step = Math.min(4, Math.ceil((value / max) * 4));
	return { background: color, opacity: [0.15, 0.4, 0.7, 1][step - 1] };
}

/** Rows a week shows before "Show more". */
const WEEK_ROWS = 20;

/** Repos hidden across the page — a per-viewer preference, so localStorage. */
const EXCLUDED_KEY = "odin.insights.excludedRepos";

function readExcluded(): Set<string> {
	try {
		const saved = JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? "[]");
		return new Set(Array.isArray(saved) ? saved.map(String) : []);
	} catch {
		return new Set();
	}
}

/**
 * What a row's hours are: the session's own active time, summed from bursts
 * that can be days apart — never read as "one sitting".
 */
function taskTime(task: {
	startedAt: number;
	endedAt?: number;
	stretches?: number;
}): string {
	const span =
		task.endedAt && DATE.format(task.endedAt) !== DATE.format(task.startedAt)
			? `${DATE.format(task.startedAt)} – ${DATE.format(task.endedAt)}`
			: DATE.format(task.startedAt);
	return `Agent time: ${task.stretches ? plural(task.stretches, "burst") : "active time"}, ${span}. Gaps over 5 min not counted.`;
}

type RecapWeek = {
	start: number;
	sessions: number;
	yourHours: number;
	prs: number;
	tasks: {
		sessionId: string;
		title: string;
		repo: string | null;
		person: string | null;
		source: string | null;
		hours: number;
		yourHours?: number;
		startedAt: number;
		endedAt?: number;
		stretches?: number;
		description?: string | null;
		prs: string[];
	}[];
};

/**
 * One week: what got done in it, then every hour of it, one cell each.
 *
 * Clock time in the grid, not agent time: three agents at 2am is one 2am.
 * Weeks step by the calendar rather than by the rows that came back, so a week
 * off renders as empty instead of being skipped past.
 */
/** Every word must appear somewhere in the row — title, brief, repo or person. */
function matches(task: RecapWeek["tasks"][number], query: string): boolean {
	const haystack = [task.title, task.description, task.repo, task.person]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => haystack.includes(word));
}

function WeekView({
	recap = [],
	heatmap,
	color,
	query = "",
}: {
	recap?: RecapWeek[];
	heatmap: { start: number; minutes: number[] }[];
	color: string;
	/** When set, the list searches every week instead of showing one. */
	query?: string;
}) {
	const thisWeek = weekStart(Date.now());
	const [start, setStart] = useState(thisWeek);
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const byWeek = useMemo(
		() => new Map(heatmap.map((week) => [week.start, week.minutes])),
		[heatmap],
	);
	const week = recap.find((row) => row.start === start);
	const searching = query.trim() !== "";
	const matching = searching
		? recap
				.flatMap((row) => row.tasks)
				.filter((task) => matches(task, query))
				.sort((a, b) => b.startedAt - a.startedAt)
		: (week?.tasks ?? []);
	// Only work you put time into: an automation's run, or a session that only
	// brushed this week, has no human time and isn't something you did.
	const listed = matching.filter((task) => task.yourHours);
	const [expanded, setExpanded] = useState(false);
	const tasks = expanded ? listed : listed.slice(0, WEEK_ROWS);
	const earliest = Math.min(
		recap[0]?.start ?? thisWeek,
		heatmap[0]?.start ?? thisWeek,
	);
	const cells = byWeek.get(start);

	return (
		<Card>
			{searching ? (
				<div className="mb-3 text-[12px] text-[#d6d6dc]">
					{listed.length
						? `${plural(listed.length, "match")} across every week, newest first`
						: "No task matches that."}
				</div>
			) : (
				<div className="mb-3 flex items-center gap-2">
					<Step
						label="Previous week"
						glyph="‹"
						disabled={start <= earliest}
						onClick={() => setStart(shiftWeeks(start, -1))}
					/>
					<Step
						label="Next week"
						glyph="›"
						disabled={start >= thisWeek}
						onClick={() => setStart(shiftWeeks(start, 1))}
					/>
					<div className="text-[12px] text-[#d6d6dc]">
						{start === thisWeek
							? "This week"
							: `${DATE.format(start)} – ${DATE.format(shiftWeeks(start, 1) - DAY_MS)}`}
					</div>
					<div className="ml-auto text-[11.5px] tabular-nums text-[#a5a5b3]">
						{week
							? `${plural(week.sessions, "session")} · ${duration(week.yourHours)} of yours · ${plural(week.prs, "PR")}`
							: "nothing logged"}
					</div>
				</div>
			)}

			{tasks.length > 0 && (
				<div className="mb-4 flex flex-col divide-y divide-[#1f1f27]">
					{tasks.map((task) => (
						<div
							key={task.sessionId}
							className="flex items-baseline gap-3 py-1.5"
						>
							<div
								title="Your time: while its pane was open and you were active, plus the gap before each prompt you typed (up to 5 min)."
								className="w-10 shrink-0 text-left text-[12.5px] font-semibold tabular-nums"
								style={{ color: YOU_COLOR }}
							>
								{duration(task.yourHours ?? 0)}
							</div>
							<div
								title={taskTime(task)}
								className="w-9 shrink-0 text-left text-[11px] tabular-nums"
								style={{ color: AGENT_COLOR }}
							>
								{duration(task.hours)}
							</div>
							{searching && (
								<div className="w-12 shrink-0 text-[10.5px] tabular-nums text-[#6f6f7d]">
									{DATE.format(task.startedAt)}
								</div>
							)}
							{/* Titles arrive in whatever language the ask was written in. */}
							<div
								dir="auto"
								title={task.description ?? task.title}
								className="min-w-0 flex-1 cursor-default truncate text-[12.5px] text-[#e4e4ea]"
							>
								{task.title}
							</div>
							{task.person && (
								<span className="shrink-0 text-[10.5px] text-[#8a8a97]">
									{task.person}
								</span>
							)}
							{task.repo && (
								<span className="shrink-0 rounded-[4px] bg-[#1b1b22] px-1.5 py-[1px] text-[10.5px] text-[#a5a5b3]">
									{task.repo}
								</span>
							)}
							{task.prs.length > 0 && (
								<button
									type="button"
									title={task.prs.join("\n")}
									onClick={() => openUrl.mutate(task.prs.at(-1) as string)}
									className="shrink-0 text-[10.5px] tabular-nums text-[#3ecf8e] hover:underline"
								>
									{task.prs.length === 1
										? `#${task.prs[0]?.split("/").pop()}`
										: plural(task.prs.length, "PR")}
								</button>
							)}
						</div>
					))}
				</div>
			)}
			{listed.length > WEEK_ROWS && (
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="-mt-2 mb-4 text-[11px] text-[#8a8a97] hover:text-[#e4e4ea]"
				>
					{expanded ? "Show less" : `Show ${listed.length - WEEK_ROWS} more`}
				</button>
			)}

			{!searching && <HourGrid cells={cells} color={color} />}
		</Card>
	);
}

type Clock = "you" | "agents";

/** Whose hours the grids paint: yours, or any agent running — the off-hours. */
function ClockToggle({
	clock,
	setClock,
}: {
	clock: Clock;
	setClock: (clock: Clock) => void;
}) {
	return (
		<div className="flex rounded-[6px] border border-[#25252e] bg-[#16161b] p-[2px] text-[10.5px]">
			{(["you", "agents"] as const).map((option) => (
				<button
					key={option}
					type="button"
					aria-pressed={clock === option}
					onClick={() => setClock(option)}
					className={`rounded-[4px] px-2 py-[1px] ${clock === option ? "bg-[#25252e] text-[#e4e4ea]" : "text-[#8a8a97] hover:text-[#e4e4ea]"}`}
				>
					{option === "you" ? "My time" : "Agent time"}
				</button>
			))}
		</div>
	);
}

function Step({
	label,
	glyph,
	disabled,
	onClick,
}: {
	label: string;
	glyph: string;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className="h-[22px] w-[22px] rounded-[6px] border border-[#25252e] bg-[#16161b] text-[13px] leading-none text-[#a5a5b3] hover:bg-[#1d1d24] disabled:opacity-35 disabled:hover:bg-[#16161b]"
		>
			{glyph}
		</button>
	);
}

const METHOD = [
	"Your time: while a session's pane was open in a focused Odin with you active in the last 2 min, plus the gap before each prompt you typed (up to 5 min) — the only record before pane time was logged.",
	"Agent work: each session's active time less yours, plus subagents; parallel agents counted each.",
	"Before pane time was logged, your time is a floor, so the gain is a ceiling.",
].join("\n");

/** Two numbers that only mean something next to each other. */
function Headline({
	agentHours,
	yourHours,
	leverage,
	sessions,
}: {
	agentHours: number;
	yourHours: number;
	leverage: number | null;
	sessions: number;
}) {
	return (
		<Card>
			<div className="flex flex-wrap items-end gap-x-8 gap-y-3">
				<Big value={duration(yourHours)} color={YOU_COLOR} label="your time" />
				<Big
					value={duration(agentHours)}
					color={AGENT_COLOR}
					label="of agent work"
				/>
				{leverage !== null && (
					// Agent work over your time, as the gain on top of it: 4.9× is +390%.
					<Big
						value={`+${Math.round((leverage - 1) * 100)}%`}
						color="#f5f5f7"
						label="agent work on top of yours"
					/>
				)}
			</div>
			<div className="mt-3 text-[11px] text-[#6f6f7d]">
				{plural(sessions, "session")} ·{" "}
				<span
					className="cursor-help underline decoration-dotted underline-offset-2"
					title={METHOD}
				>
					how it's counted
				</span>
			</div>
		</Card>
	);
}

function Big({
	value,
	color,
	label,
}: {
	value: string;
	color: string;
	label: string;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="text-[26px] font-semibold leading-none" style={{ color }}>
				{value}
			</div>
			<div className="text-[12px] text-[#a5a5b3]">{label}</div>
		</div>
	);
}

/**
 * The repo filter for the whole page. Clicking a name keeps only that repo;
 * × hides one, and a hidden repo stays listed, struck through, to bring back.
 */
function RepoFilter({
	repos: all,
	repo,
	setRepo,
	excluded,
	toggleExcluded,
}: {
	repos: string[];
	repo: string | null;
	setRepo: (repo: string | null) => void;
	excluded: Set<string>;
	toggleExcluded: (repo: string) => void;
}) {
	const repos = all.filter((name) => !excluded.has(name));
	const filtered = repo !== null || excluded.size > 0;
	if (repos.length <= 1 && !filtered) return null;
	return (
		<div className="flex flex-wrap gap-1.5">
			{[null, ...repos].map((name) => (
				<div
					key={name ?? "all"}
					className={`flex items-center rounded-[6px] border text-[10.5px] ${
						repo === name
							? "border-[#a394ff] bg-[#a394ff22] text-[#e4e4ea]"
							: "border-[#25252e] bg-[#16161b] text-[#a5a5b3]"
					}`}
				>
					<button
						type="button"
						onClick={() => setRepo(name)}
						className="px-2 py-[2px] hover:text-[#e4e4ea]"
					>
						{name ?? "All repos"}
					</button>
					{name && (
						<button
							type="button"
							aria-label={`Hide ${name}`}
							title="Hide this repo"
							onClick={() => toggleExcluded(name)}
							className="pr-1.5 text-[#6f6f7d] hover:text-[#e4e4ea]"
						>
							×
						</button>
					)}
				</div>
			))}
			{[...excluded].map((name) => (
				<button
					key={name}
					type="button"
					title="Hidden — click to show again"
					onClick={() => toggleExcluded(name)}
					className="rounded-[6px] border border-dashed border-[#25252e] px-2 py-[2px] text-[10.5px] text-[#6f6f7d] line-through hover:text-[#a5a5b3]"
				>
					{name}
				</button>
			))}
		</div>
	);
}

function Workload() {
	const [repo, setRepo] = useState<string | null>(null);
	const [excluded, setExcluded] = useState(readExcluded);
	const [query, setQuery] = useState("");
	const [clock, setClock] = useState<Clock>("you");
	const search = useSearchHotkey();
	const toggleExcluded = (name: string) => {
		const next = new Set(excluded);
		if (!next.delete(name)) next.add(name);
		if (name === repo) setRepo(null);
		setExcluded(next);
		try {
			localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...next]));
		} catch {}
	};
	const { data, isLoading, isPlaceholderData } =
		electronTrpc.insights.workload.useQuery(
			{ only: repo, hide: [...excluded] },
			{
				refetchInterval: 120_000,
				staleTime: 60_000,
				// Switching repos keeps the old numbers up until the new ones land.
				placeholderData: (previous) => previous,
			},
		);

	if (isLoading || !data) return <Loading />;
	// `agentHeatmap` is absent until the main process restarts onto this build.
	const grid = clock === "agents" ? (data.agentHeatmap ?? []) : data.heatmap;
	const gridColor = clock === "agents" ? AGENT_COLOR : YOU_COLOR;
	const filter = (
		<div className="flex items-start gap-2">
			<input
				ref={search.ref}
				type="search"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") setQuery("");
				}}
				placeholder={`Search tasks…${search.hint}`}
				aria-label="Search tasks"
				className="h-[22px] w-[180px] shrink-0 rounded-[6px] border border-[#25252e] bg-[#16161b] px-2 text-[11px] text-[#e4e4ea] placeholder:text-[#6f6f7d] focus:border-[#a394ff] focus:outline-none"
			/>
			<RepoFilter
				repos={data.repos ?? data.byRepo.map((row) => row.repo)}
				repo={repo}
				setRepo={setRepo}
				excluded={excluded}
				toggleExcluded={toggleExcluded}
			/>
			{isPlaceholderData && (
				<span className="pt-[5px]">
					<Spinner />
				</span>
			)}
		</div>
	);
	if (data.sessions === 0)
		return (
			<div className="flex flex-col gap-3">
				{filter}
				<Empty>
					{repo || excluded.size
						? "No sessions in these repos."
						: "No agent transcripts on this machine yet."}
				</Empty>
			</div>
		);

	return (
		<div className="flex flex-col gap-5">
			{filter}
			{/* The previous filter's numbers stay up, dimmed, until the new ones land. */}
			<div
				className={`flex flex-col gap-5 transition-opacity ${isPlaceholderData ? "opacity-40" : ""}`}
			>
				<Section
					title="Time with agents"
					note={data.since ? `since ${DATE.format(data.since)}` : undefined}
				>
					<Headline
						agentHours={data.agentHours}
						yourHours={data.yourHours}
						leverage={data.leverage}
						sessions={data.sessions}
					/>
				</Section>

				<Section title="What you did">
					<WeekView
						recap={data.recap}
						heatmap={grid}
						color={gridColor}
						query={query}
					/>
				</Section>

				<Section
					title="Every week"
					note="all recorded weeks, folded into one"
					aside={<ClockToggle clock={clock} setClock={setClock} />}
				>
					<AllWeeksGrid heatmap={grid} color={gridColor} />
				</Section>

				<Section title="Week by week">
					<WeekChart weeks={data.weeks} />
					<div className="flex gap-4 pl-1 pt-0.5">
						<Legend color={YOU_COLOR} label="your time" />
						<Legend color={AGENT_COLOR} label="agent work" />
					</div>
				</Section>

				<div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
					<Section title="Where the hours went" note="by repo">
						<BarGroup
							rows={data.byRepo.map((row) => ({
								name: row.repo,
								weight: row.hours,
								value: `${duration(row.hours)} · ${plural(row.sessions, "session")}`,
							}))}
						/>
					</Section>

					<Section title="Whose work you ran" note="by person">
						{data.byPerson.length === 0 ? (
							<Empty>Nothing launched from a feed yet.</Empty>
						) : (
							<BarGroup
								rows={data.byPerson.map((row) => ({
									name: row.person,
									weight: row.hours,
									value: `${duration(row.hours)} · ${plural(row.sessions, "session")}`,
								}))}
							/>
						)}
					</Section>
				</div>
			</div>
		</div>
	);
}

function Legend({ color, label }: { color: string; label: string }) {
	return (
		<span className="flex items-center gap-1.5 text-[10.5px] text-[#8a8a97]">
			<span
				className="h-[7px] w-[7px] rounded-full"
				style={{ background: color }}
			/>
			{label}
		</span>
	);
}

function Queue() {
	const { data, isLoading } = electronTrpc.insights.summary.useQuery(
		undefined,
		{ refetchInterval: 60_000 },
	);

	if (isLoading || !data) return <Loading />;

	// A main process started before `gaps` existed won't send it.
	const gaps = data.gaps ?? [];
	const pickup =
		data.medianPickupHours === null ? "—" : duration(data.medianPickupHours);

	return (
		<div className="flex flex-col gap-5">
			<Section title="Your queue">
				<div className="flex flex-wrap gap-2">
					<Stat value={String(data.seen)} label="asks" />
					<Stat value={String(data.waiting)} label="waiting" />
					<Stat value={String(data.delegated)} label="delegated" />
					<Stat value={String(data.done)} label="done" />
					<Stat
						value={pickup}
						label="median pickup"
						hint={
							data.slowestPickupHours === null
								? undefined
								: `slowest ${duration(data.slowestPickupHours)}`
						}
					/>
				</div>
			</Section>

			<Section
				title="Improvements"
				note="channels and people whose asks you mostly leave — under half picked up or marked done"
			>
				{gaps.length === 0 ? (
					<Empty>No channel or person you're leaving behind.</Empty>
				) : (
					<Card>
						<div className="flex flex-col gap-1.5">
							{gaps.map((gap) => (
								<Link
									key={`${gap.kind}:${gap.name}`}
									to="/reactions"
									search={
										gap.kind === "channel"
											? { channel: gap.name }
											: { person: gap.name }
									}
									title="Open these asks in the Slack feed"
									className="-mx-1.5 flex items-baseline gap-2.5 rounded px-1.5 text-[12px] hover:bg-[#1f1f27]"
								>
									<div className="w-[180px] shrink-0 truncate text-[#d6d6dc]">
										{gap.kind === "channel" && gap.name !== "DMs"
											? `#${gap.name}`
											: gap.name}
									</div>
									<div className="text-[#a5a5b3]">
										{gap.handled === 0
											? `never picked up — 0 of ${gap.seen}`
											: `${gap.handled} of ${gap.seen} picked up`}
										{gap.waiting > 0 && (
											<span className="text-[#6f6f7d]">
												{` · ${gap.waiting} still waiting`}
											</span>
										)}
									</div>
								</Link>
							))}
						</div>
					</Card>
				)}
			</Section>

			<div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
				<Section title="Who asks">
					{data.askers.length === 0 ? (
						<Empty>No asks recorded yet.</Empty>
					) : (
						<BarGroup
							rows={data.askers.map((asker) => ({
								name: asker.name,
								weight: asker.asks,
								value: plural(asker.asks, "ask"),
							}))}
						/>
					)}
				</Section>

				<Section title="Where work comes from">
					{data.bySource.length === 0 ? (
						<Empty>Nothing launched from a feed yet.</Empty>
					) : (
						<BarGroup
							rows={data.bySource.map((row) => ({
								name: SOURCE_LABEL[row.source] ?? row.source,
								weight: row.count,
								value: String(row.count),
							}))}
						/>
					)}
				</Section>
			</div>
		</div>
	);
}

/**
 * Native `title` tooltips wait ~1s and the delay can't be tuned. This swaps
 * every `title` under `root` for an instant one, so call sites keep plain
 * `title=` and a new one is fast for free.
 */
function useFastTitles(root: React.RefObject<HTMLElement | null>) {
	const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(
		null,
	);
	useEffect(() => {
		const el = root.current;
		if (!el) return;
		let held: Element | null = null;
		const release = () => {
			if (held)
				held.setAttribute("title", held.getAttribute("data-title") ?? "");
			held = null;
			setTip(null);
		};
		const over = (event: MouseEvent) => {
			const target = (event.target as Element).closest("[title]");
			if (!target || !el.contains(target)) return;
			release();
			const text = target.getAttribute("title") ?? "";
			if (!text) return;
			held = target;
			target.setAttribute("data-title", text);
			target.removeAttribute("title");
			setTip({ text, x: event.clientX, y: event.clientY });
		};
		const move = (event: MouseEvent) => {
			if (held)
				setTip((t) => t && { ...t, x: event.clientX, y: event.clientY });
		};
		const out = (event: MouseEvent) => {
			if (held && !held.contains(event.relatedTarget as Node)) release();
		};
		el.addEventListener("mouseover", over);
		el.addEventListener("mousemove", move);
		el.addEventListener("mouseout", out);
		return () => {
			release();
			el.removeEventListener("mouseover", over);
			el.removeEventListener("mousemove", move);
			el.removeEventListener("mouseout", out);
		};
	}, [root]);
	return tip;
}

function InsightsPage() {
	const ref = useRef<HTMLDivElement>(null);
	const tip = useFastTitles(ref);
	return (
		<div ref={ref} className="h-full overflow-y-auto px-[18px] pb-10 pt-4">
			{tip && (
				<div
					className="pointer-events-none fixed z-50 max-w-xs whitespace-pre-line rounded-md border border-[#2a2a34] bg-[#15151b] px-2 py-1 text-[11.5px] text-[#d6d6dc] shadow-lg"
					style={{
						left: Math.min(tip.x + 12, window.innerWidth - 330),
						top: tip.y + 16,
					}}
				>
					{tip.text}
				</div>
			)}
			{/* Capped, not full-bleed: on a wide window every row stretched to
			    2000px and nothing lined up close enough to compare. */}
			{/* One spinner until every section has data — half a page popping in
			    under a skeleton read as broken. */}
			<div className="group mx-auto w-full max-w-[1120px]">
				<div className="hidden h-[60vh] items-center justify-center gap-2 text-[12px] text-[#6f6f7d] group-has-[[aria-busy=true]]:flex">
					<Spinner />
					Loading insights…
				</div>
				<div className="flex flex-col gap-7 group-has-[[aria-busy=true]]:hidden">
					<Workload />
					<div className="h-px bg-[#1f1f27]" />
					<Queue />
				</div>
			</div>
		</div>
	);
}
