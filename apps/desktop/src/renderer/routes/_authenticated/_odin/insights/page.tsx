import { createFileRoute } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";

export const Route = createFileRoute("/_authenticated/_odin/insights/")({
	component: InsightsPage,
});

/**
 * Insights — what lands on you, what you do with it, and what it cost.
 *
 * Deliberately arithmetic, not a model call: these are questions with exact
 * answers, and a summary you have to wait fifteen seconds for is one you stop
 * opening. The queue half is scoped to the active profile; the workload half
 * is counted off the transcript store, which is per-machine and reaches much
 * further back than Odin's own ledger.
 */

const SOURCE_LABEL: Record<string, string> = {
	reactions: "Slack",
	jira: "Jira",
	pr: "GitHub",
	notion: "Notion",
};

const AGENT_COLOR = "#a394ff";
const YOU_COLOR = "#3ecf8e";

function Stat({
	value,
	label,
	hint,
	accent,
}: {
	value: string;
	label: string;
	hint?: string;
	accent?: string;
}) {
	return (
		<div className="flex min-w-[120px] flex-1 flex-col gap-1 rounded-[10px] border border-[#25252e] bg-[#111114] px-3.5 py-3">
			<div
				className="text-[22px] font-semibold leading-none"
				style={{ color: accent ?? "#f5f5f7" }}
			>
				{value}
			</div>
			<div className="text-[11.5px] text-[#a5a5b3]">{label}</div>
			{hint && <div className="text-[10.5px] text-[#6f6f7d]">{hint}</div>}
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
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline gap-2">
				<div className="text-[11px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
					{title}
				</div>
				{note && <div className="text-[11px] text-[#6f6f7d]">{note}</div>}
			</div>
			{children}
		</div>
	);
}

/** A labelled bar, width relative to the biggest row in its group. */
function Bar({
	name,
	count,
	max,
	value,
	color = AGENT_COLOR,
}: {
	name: string;
	count: number;
	max: number;
	/** What to print at the end of the row, when it isn't just the count. */
	value?: string;
	color?: string;
}) {
	return (
		<div className="flex items-center gap-3">
			<div className="w-[150px] shrink-0 truncate text-[12px] text-[#d6d6dc]">
				{name}
			</div>
			<div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[#1b1b22]">
				<div
					className="h-full rounded-full"
					style={{
						width: `${Math.max(4, (count / max) * 100)}%`,
						background: color,
					}}
				/>
			</div>
			<div className="w-14 shrink-0 text-right text-[11.5px] text-[#a5a5b3]">
				{value ?? count}
			</div>
		</div>
	);
}

/** "4.5h" under an hour reads as minutes — 0.3h is not a duration anyone says. */
function duration(hours: number): string {
	if (hours <= 0) return "0";
	return hours < 1 ? `${Math.round(hours * 60)}m` : `${hours}h`;
}

const WEEKDAY_MONTH = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
});

function LegendDot({ color, label }: { color: string; label: string }) {
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

/**
 * Weeks as paired columns: agent time against your time.
 *
 * Both are drawn on the same scale on purpose — the gap between the two bars
 * IS the story, and a chart that rescaled each series would flatten it. Weeks
 * from before the transcript store begins are drawn as a dash, because "no
 * record" and "no work" are different answers.
 */
function WeekBars({
	weeks,
	since,
}: {
	weeks: {
		start: number;
		agentHours: number;
		yourHours: number;
		sessions: number;
	}[];
	since: number | null;
}) {
	const max = Math.max(1, ...weeks.map((week) => week.agentHours));
	return (
		<div className="flex items-end gap-1.5 rounded-[10px] border border-[#25252e] bg-[#111114] px-3 pb-2 pt-3">
			{weeks.map((week) => {
				const known = since === null || week.start + 7 * 86_400_000 > since;
				return (
					<div
						key={week.start}
						className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
						title={
							known
								? `${WEEKDAY_MONTH.format(week.start)} — ${week.sessions} sessions, ${duration(week.agentHours)} agent time, ${duration(week.yourHours)} yours`
								: `${WEEKDAY_MONTH.format(week.start)} — before the transcript record starts`
						}
					>
						<div className="flex h-[88px] w-full items-end justify-center gap-[3px]">
							{known ? (
								<>
									<Column
										hours={week.agentHours}
										max={max}
										color={AGENT_COLOR}
									/>
									<Column hours={week.yourHours} max={max} color={YOU_COLOR} />
								</>
							) : (
								<div className="mb-2 h-[2px] w-3 rounded-full bg-[#25252e]" />
							)}
						</div>
						<div className="truncate text-[10px] text-[#6f6f7d]">
							{WEEKDAY_MONTH.format(week.start)}
						</div>
					</div>
				);
			})}
		</div>
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
			className="w-full max-w-[16px] rounded-t-[3px]"
			style={{
				// A worked week never renders as nothing: a hairline still reads
				// as "some", which a zero-height bar doesn't.
				height: hours > 0 ? `${Math.max(3, (hours / max) * 88)}px` : "1px",
				background: hours > 0 ? color : "#25252e",
			}}
		/>
	);
}

/** The 24 buckets of `byHour`, labelled — a fixed axis, not a list of data. */
const HOURS = Array.from({ length: 24 }, (_, hour) =>
	String(hour).padStart(2, "0"),
);

/** Active minutes per hour of the day — when you actually run agents. */
function DayClock({ byHour }: { byHour: number[] }) {
	const max = Math.max(1, ...byHour);
	return (
		<div className="flex flex-col gap-1.5 rounded-[10px] border border-[#25252e] bg-[#111114] px-3 pb-2 pt-3">
			<div className="flex h-[40px] items-end gap-[2px]">
				{HOURS.map((label, hour) => {
					const minutes = byHour[hour] ?? 0;
					return (
						<div
							key={label}
							className="flex-1 rounded-t-[2px]"
							style={{
								height: `${Math.max(1, (minutes / max) * 40)}px`,
								background: minutes > 0 ? AGENT_COLOR : "#25252e",
								opacity: minutes > 0 ? 0.35 + 0.65 * (minutes / max) : 1,
							}}
							title={`${label}:00 — ${duration(Math.round((minutes / 60) * 10) / 10)}`}
						/>
					);
				})}
			</div>
			<div className="flex justify-between text-[10px] text-[#6f6f7d]">
				<span>00</span>
				<span>06</span>
				<span>12</span>
				<span>18</span>
				<span>23</span>
			</div>
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
		return (
			<div className="text-[12px] text-[#6f6f7d]">
				No agent transcripts on this machine yet.
			</div>
		);

	const maxRepo = Math.max(1, ...data.byRepo.map((row) => row.hours));
	const maxPerson = Math.max(1, ...data.byPerson.map((row) => row.hours));
	const peak = data.byHour.indexOf(Math.max(...data.byHour));

	return (
		<>
			<div className="flex flex-wrap gap-2">
				<Stat
					value={duration(data.agentHours)}
					label="agent time"
					hint={`${data.sessions} sessions`}
					accent={AGENT_COLOR}
				/>
				<Stat
					value={duration(data.yourHours)}
					label="your time at it"
					hint="overlapping sessions counted once"
					accent={YOU_COLOR}
				/>
				<Stat
					value={data.leverage === null ? "—" : `${data.leverage}×`}
					label="agent hours per hour of yours"
				/>
				<Stat
					value={data.busiestDay ? duration(data.busiestDay.hours) : "—"}
					label="busiest day"
					hint={
						data.busiestDay
							? WEEKDAY_MONTH.format(data.busiestDay.at)
							: undefined
					}
				/>
				<Stat
					value={`${String(peak).padStart(2, "0")}:00`}
					label="your busiest hour"
				/>
			</div>

			<Section
				title="By week"
				note={
					data.since
						? `transcripts go back to ${WEEKDAY_MONTH.format(data.since)}`
						: undefined
				}
			>
				<WeekBars weeks={data.weeks} since={data.since} />
				<div className="flex gap-3 pl-0.5">
					<LegendDot color={AGENT_COLOR} label="agent time" />
					<LegendDot color={YOU_COLOR} label="your time" />
				</div>
			</Section>

			<Section title="Longest runs" note="active time, idle gaps removed">
				<div className="flex flex-col divide-y divide-[#1f1f27] overflow-hidden rounded-[10px] border border-[#25252e] bg-[#111114]">
					{data.longest.map((task) => (
						<div
							key={task.sessionId}
							className="flex items-center gap-3 px-3.5 py-2.5"
						>
							<div className="w-11 shrink-0 text-right text-[13px] font-semibold text-[#f5f5f7]">
								{duration(task.hours)}
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="truncate text-[12px] text-[#d6d6dc]">
									{task.title}
								</div>
								<div className="flex items-center gap-2 text-[10.5px] text-[#6f6f7d]">
									{task.repo && <span>{task.repo}</span>}
									<span>{WEEKDAY_MONTH.format(task.startedAt)}</span>
									{task.person && (
										<span style={{ color: "#8a8a97" }}>
											for {task.person}
											{task.source
												? ` · ${SOURCE_LABEL[task.source] ?? task.source}`
												: ""}
										</span>
									)}
								</div>
							</div>
						</div>
					))}
				</div>
			</Section>

			<Section title="Where the hours went" note="by repo">
				<div className="flex flex-col gap-1.5">
					{data.byRepo.map((row) => (
						<Bar
							key={row.repo}
							name={row.repo}
							count={row.hours}
							max={maxRepo}
							value={`${duration(row.hours)} · ${row.sessions}`}
						/>
					))}
				</div>
			</Section>

			<Section
				title="Whose work you ran"
				note={`${data.attributed} of ${data.sessions} sessions came in from a feed`}
			>
				{data.byPerson.length === 0 ? (
					<div className="text-[12px] text-[#6f6f7d]">
						Nothing attributed yet — this fills as you launch from a feed.
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{data.byPerson.map((row) => (
							<Bar
								key={row.person}
								name={row.person}
								count={row.hours}
								max={maxPerson}
								color={YOU_COLOR}
								value={`${duration(row.hours)} · ${row.sessions}`}
							/>
						))}
					</div>
				)}
			</Section>

			<Section title="When you work" note="active minutes by hour of day">
				<DayClock byHour={data.byHour} />
			</Section>
		</>
	);
}

function InsightsPage() {
	const { data, isLoading } = electronTrpc.insights.summary.useQuery(
		undefined,
		{
			refetchInterval: 60_000,
		},
	);

	if (isLoading || !data)
		return (
			<div className="flex h-full items-center justify-center text-[12px] text-[#6f6f7d]">
				Counting…
			</div>
		);

	const pickup =
		data.medianPickupHours === null
			? "—"
			: data.medianPickupHours < 1
				? `${Math.round(data.medianPickupHours * 60)}m`
				: `${data.medianPickupHours}h`;
	const maxAsks = Math.max(1, ...data.askers.map((a) => a.asks));
	const maxSource = Math.max(1, ...data.bySource.map((s) => s.count));

	return (
		<div className="flex h-full flex-col gap-5 overflow-y-auto px-[18px] pb-[18px] pt-3">
			<div className="flex flex-wrap gap-2">
				<Stat value={String(data.seen)} label="asks seen" />
				<Stat value={String(data.waiting)} label="still waiting on you" />
				<Stat value={String(data.delegated)} label="handed to an agent" />
				<Stat value={String(data.done)} label="marked done" />
				<Stat
					value={pickup}
					label="median time to pick up"
					hint={
						data.slowestPickupHours === null
							? undefined
							: `slowest ${data.slowestPickupHours}h`
					}
				/>
			</div>

			<Section title="Who asks" note="from your Slack queue">
				{data.askers.length === 0 ? (
					<div className="text-[12px] text-[#6f6f7d]">
						No asks recorded yet.
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{data.askers.map((asker) => (
							<Bar
								key={asker.name}
								name={asker.name}
								count={asker.asks}
								max={maxAsks}
							/>
						))}
					</div>
				)}
			</Section>

			<Section
				title="Where work comes from"
				note={`${data.delegationsLogged} logged since the ledger landed`}
			>
				{data.bySource.length === 0 ? (
					<div className="text-[12px] text-[#6f6f7d]">
						Nothing logged yet — this fills as you start sessions from a feed.
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						{data.bySource.map((row) => (
							<Bar
								key={row.source}
								name={SOURCE_LABEL[row.source] ?? row.source}
								count={row.count}
								max={maxSource}
							/>
						))}
					</div>
				)}
			</Section>

			<div className="h-px bg-[#1f1f27]" />

			<Workload />
		</div>
	);
}
