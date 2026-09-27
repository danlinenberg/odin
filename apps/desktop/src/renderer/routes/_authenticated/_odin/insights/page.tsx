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

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const DAY_MS = 86_400_000;

/**
 * Monday 00:00 local. The same rule the main process buckets cells by — four
 * lines duplicated rather than imported, because that module reaches for
 * `node:fs` and can't come into the renderer.
 */
function weekStart(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
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

/** Repos hidden from "What you did" — a per-viewer preference, so localStorage. */
const EXCLUDED_KEY = "odin.insights.excludedRepos";

function readExcluded(): Set<string> {
	try {
		const saved = JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? "[]");
		return new Set(Array.isArray(saved) ? saved.map(String) : []);
	} catch {
		return new Set();
	}
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
function WeekView({
	recap = [],
	heatmap,
}: {
	recap?: RecapWeek[];
	heatmap: { start: number; minutes: number[] }[];
}) {
	const thisWeek = weekStart(Date.now());
	const [start, setStart] = useState(thisWeek);
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const byWeek = useMemo(
		() => new Map(heatmap.map((week) => [week.start, week.minutes])),
		[heatmap],
	);
	// Kept across week steps, so you can page back through one repo's weeks.
	const [repo, setRepo] = useState<string | null>(null);
	const [excluded, setExcluded] = useState(readExcluded);
	const toggleExcluded = (name: string) => {
		const next = new Set(excluded);
		if (!next.delete(name)) next.add(name);
		if (name === repo) setRepo(null);
		setExcluded(next);
		try {
			localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...next]));
		} catch {}
	};
	const week = recap.find((row) => row.start === start);
	const repos = [
		...new Set([
			...(week?.tasks.flatMap((task) => (task.repo ? [task.repo] : [])) ?? []),
			...(repo ? [repo] : []),
		]),
	].filter((name) => !excluded.has(name));
	const matching =
		week?.tasks.filter(
			(task) =>
				(!repo || task.repo === repo) &&
				!(task.repo && excluded.has(task.repo)),
		) ?? [];
	const filtered = repo !== null || excluded.size > 0;
	const tasks = matching.slice(0, 8);
	const earliest = Math.min(
		recap[0]?.start ?? thisWeek,
		heatmap[0]?.start ?? thisWeek,
	);
	const cells = byWeek.get(start);

	return (
		<Card>
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
					{!week
						? "nothing logged"
						: filtered
							? // ponytail: a repo's totals are summed from its listed sessions,
								// so sub-10-minute lookups without a PR aren't in them.
								`${plural(matching.length, "session")} · ${duration(
									matching.reduce((sum, task) => sum + task.hours, 0),
								)} of agent work · ${plural(
									matching.reduce((sum, task) => sum + task.prs.length, 0),
									"PR",
								)}`
							: `${plural(week.sessions, "session")} · ${duration(week.yourHours)} on the clock · ${plural(week.prs, "PR")}`}
				</div>
			</div>

			{repos.length > 1 || filtered ? (
				<div className="mb-3 flex flex-wrap gap-1.5">
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
			) : null}

			{tasks.length > 0 && (
				<div className="mb-4 flex flex-col divide-y divide-[#1f1f27]">
					{tasks.map((task) => (
						<div
							key={task.sessionId}
							className="flex items-baseline gap-3 py-1.5"
						>
							<div
								className="w-10 shrink-0 text-right text-[12.5px] font-semibold tabular-nums"
								style={{ color: AGENT_COLOR }}
							>
								{duration(task.hours)}
							</div>
							{/* Titles arrive in whatever language the ask was written in. */}
							<div
								dir="auto"
								className="min-w-0 flex-1 truncate text-[12.5px] text-[#e4e4ea]"
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

function Workload() {
	const { data, isLoading } = electronTrpc.insights.workload.useQuery(
		undefined,
		{ refetchInterval: 120_000, staleTime: 60_000 },
	);

	if (isLoading || !data)
		return (
			<div className="text-[12px] text-[#6f6f7d]">Reading transcripts…</div>
		);
	if (data.sessions === 0)
		return <Empty>No agent transcripts on this machine yet.</Empty>;

	return (
		<div className="flex flex-col gap-5">
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
				<WeekView recap={data.recap} heatmap={data.heatmap} />
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
		return <div className="text-[12px] text-[#6f6f7d]">Counting…</div>;

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
