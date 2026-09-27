import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

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
	children,
}: {
	title: string;
	note?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<Heading title={title} note={note} />
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
	color = AGENT_COLOR,
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

/** A spinner over placeholder cards shaped like what's coming. */
function Loading({ label, blocks }: { label: string; blocks: number[] }) {
	return (
		<div className="flex flex-col gap-3" aria-busy="true">
			<div className="flex items-center gap-2 text-[12px] text-[#6f6f7d]">
				<Spinner />
				{label}
			</div>
			{blocks.map((height) => (
				<div
					key={height}
					className="animate-pulse rounded-[10px] border border-[#1f1f27] bg-[#131318]"
					style={{ height }}
				/>
			))}
		</div>
	);
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
						title={`${week.sessions} sessions · ${duration(week.agentHours)} of agent work over ${duration(week.yourHours)} on the clock`}
					>
						{/* justify-end so the number rides on top of its own bar
						    instead of floating at the top of an empty column. */}
						<div className="flex h-[132px] w-full flex-col items-center justify-end">
							<div className="mb-1 text-[11px] font-medium tabular-nums text-[#d6d6dc]">
								{week.agentHours > 0 ? duration(week.agentHours) : "—"}
							</div>
							<div className="flex w-full items-end justify-center gap-[4px]">
								<Column hours={week.agentHours} max={max} color={AGENT_COLOR} />
								<Column hours={week.yourHours} max={max} color={YOU_COLOR} />
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

/** A fixed 24-hour axis, not a list of data. */
const HOURS = Array.from({ length: 24 }, (_, hour) =>
	String(hour).padStart(2, "0"),
);

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
 * One cell holds at most an hour, so the scale is absolute: sixty minutes is
 * full, and a shade means the same thing in every week. Rescaling per week
 * would light up a dead Tuesday for being that week's busiest hour.
 */
function cellStyle(minutes: number): React.CSSProperties {
	if (minutes <= 0) return { background: "#1b1b22" };
	// Four steps rather than a continuous ramp — quantised, a cell can actually
	// be matched back to the legend.
	const step = Math.min(4, Math.ceil((minutes / 60) * 4));
	return { background: YOU_COLOR, opacity: 0.2 + 0.2 * step };
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
	query = "",
}: {
	recap?: RecapWeek[];
	heatmap: { start: number; minutes: number[] }[];
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
	const [expanded, setExpanded] = useState(false);
	const tasks = expanded ? matching : matching.slice(0, WEEK_ROWS);
	const earliest = Math.min(
		recap[0]?.start ?? thisWeek,
		heatmap[0]?.start ?? thisWeek,
	);
	const cells = byWeek.get(start);

	return (
		<Card>
			{searching ? (
				<div className="mb-3 text-[12px] text-[#d6d6dc]">
					{matching.length
						? `${plural(matching.length, "match")} across every week, newest first`
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
							? `${plural(week.sessions, "session")} · ${duration(week.yourHours)} on the clock · ${plural(week.prs, "PR")}`
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
								title={taskTime(task)}
								className="w-10 shrink-0 text-right text-[12.5px] font-semibold tabular-nums"
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
			{matching.length > WEEK_ROWS && (
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="-mt-2 mb-4 text-[11px] text-[#8a8a97] hover:text-[#e4e4ea]"
				>
					{expanded ? "Show less" : `Show ${matching.length - WEEK_ROWS} more`}
				</button>
			)}

			{!searching && (
				<div
					className="grid gap-[2px]"
					style={{ gridTemplateColumns: "28px repeat(24, minmax(0, 1fr))" }}
				>
					{WEEKDAYS.map((day, weekday) => (
						<Fragment key={day}>
							<div className="pr-1 text-right text-[10px] leading-[14px] text-[#6f6f7d]">
								{day}
							</div>
							{HOURS.map((label, hour) => {
								const minutes = cells?.[weekday * 24 + hour] ?? 0;
								return (
									<div
										key={label}
										className="h-[14px] rounded-[2px]"
										style={cellStyle(minutes)}
										title={`${day} ${label}:00 — ${minutes}m`}
									/>
								);
							})}
						</Fragment>
					))}
					{/* The hour axis, sharing the grid so labels sit under their column. */}
					<div />
					{HOURS.map((label, hour) => (
						<div
							key={label}
							className="pt-1 text-center text-[9.5px] text-[#6f6f7d]"
						>
							{hour % 3 === 0 ? label : ""}
						</div>
					))}
				</div>
			)}
		</Card>
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
				<Big
					value={duration(yourHours)}
					color={YOU_COLOR}
					label="on the clock"
				/>
				<Big
					value={duration(agentHours)}
					color={AGENT_COLOR}
					label="of agent work"
				/>
				{leverage !== null && (
					<Big value={`${leverage}×`} color="#f5f5f7" label="leverage" />
				)}
			</div>
			<div className="mt-3 text-[11px] text-[#6f6f7d]">
				{plural(sessions, "session")} · clock time counts parallel agents once,
				agent work counts each · gaps over 5 min don't count
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

	if (isLoading || !data)
		return <Loading label="Reading transcripts…" blocks={[96, 260, 170]} />;
	const filter = (
		<div className="flex items-start gap-2">
			<input
				type="search"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") setQuery("");
				}}
				placeholder="Search tasks…"
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
					<WeekView recap={data.recap} heatmap={data.heatmap} query={query} />
				</Section>

				<Section title="Week by week">
					<WeekChart weeks={data.weeks} />
					<div className="flex gap-4 pl-1 pt-0.5">
						<Legend color={AGENT_COLOR} label="agent work" />
						<Legend color={YOU_COLOR} label="hours on the clock" />
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
								color={YOU_COLOR}
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

	if (isLoading || !data)
		return <Loading label="Counting asks…" blocks={[64, 150]} />;

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

function InsightsPage() {
	return (
		<div className="h-full overflow-y-auto px-[18px] pb-10 pt-4">
			{/* Capped, not full-bleed: on a wide window every row stretched to
			    2000px and nothing lined up close enough to compare. */}
			<div className="mx-auto flex w-full max-w-[1120px] flex-col gap-7">
				<Workload />
				<div className="h-px bg-[#1f1f27]" />
				<Queue />
			</div>
		</div>
	);
}
