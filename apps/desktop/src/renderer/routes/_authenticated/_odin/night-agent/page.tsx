import { Input } from "@odin/ui/input";
import { cn } from "@odin/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
	LuArrowDown,
	LuArrowUp,
	LuMoon,
	LuPlus,
	LuSearch,
	LuX,
} from "react-icons/lu";
import {
	canPickForTonight,
	inOffHours,
	MAX_NIGHT_PICKS,
	type OffHours,
	toggleNightPick,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { NightAgentRows } from "../../settings/backlog/page";
import { SettingsSection } from "../../settings/components/SettingsPage";
import type { AllItem } from "../all/all-items";
import { SOURCE_ICON } from "../all/TaskTable";
import { useNextInLineQueue } from "../board/NextInLine";
import { useNightAgentIntro } from "../board/NightAgentIntro";

export const Route = createFileRoute("/_authenticated/_odin/night-agent/")({
	component: NightAgentPage,
});

/** The log can run to a week of nights; the page opens on the latest. */
const LOG_PREVIEW = 30;

/** The Night Agent's own screen: what it will do next, its schedule, its log. */
function NightAgentPage() {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto w-full max-w-[1600px] space-y-8 px-8 py-8">
				<StatusHero />
				<div className="grid items-start gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
					<div className="space-y-8">
						<NextRunSection />
					</div>
					<div className="space-y-8">
						<SettingsSection
							title="Schedule"
							description="When it runs, how much, and what every session is told."
						>
							<NightAgentRows />
						</SettingsSection>
						<LogSection />
					</div>
				</div>
			</div>
		</div>
	);
}

/** On or off, whether it's running now, and how far tonight has got. */
function StatusHero() {
	const offHours = useNextInLinePrompt((s) => s.offHours);
	const started = useNextInLinePrompt((s) => s.offHoursStarted);
	const lastEntry = useNextInLinePrompt((s) => s.nightLog.at(-1));
	const running =
		offHours.enabled && inOffHours(new Date(), offHours.start, offHours.end);
	const headline = !offHours.enabled
		? "Off"
		: running
			? `Running until ${offHours.end}`
			: `Next run at ${offHours.start}`;
	return (
		<section className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/15 via-card/80 to-card/40 p-6">
			<LuMoon
				className="pointer-events-none absolute -top-10 -right-6 size-56 text-primary/[.06]"
				aria-hidden
			/>
			<div className="relative flex flex-wrap items-center gap-x-10 gap-y-6">
				<div className="flex min-w-0 flex-1 items-center gap-5">
					<div
						className={cn(
							"flex size-14 shrink-0 items-center justify-center rounded-2xl",
							offHours.enabled
								? "bg-primary/20 text-primary glow-primary"
								: "bg-muted text-muted-foreground",
						)}
					>
						<LuMoon className="size-7" aria-hidden />
					</div>
					<div className="min-w-0">
						<div className="text-xs font-semibold uppercase tracking-[.08em] text-soft-foreground">
							Night Agent
						</div>
						<div className="mt-0.5 flex items-center gap-2">
							<h2 className="text-2xl font-semibold tracking-tight">
								{headline}
							</h2>
							{running && (
								<span className="flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
									<span className="size-1.5 animate-pulse rounded-full bg-primary" />
									Live
								</span>
							)}
						</div>
						<p className="mt-1 text-sm text-muted-foreground">
							{offHours.enabled
								? "Works through your picks, then Next in line, one session at a time while you're away."
								: "Turn it on under Schedule."}
						</p>
					</div>
				</div>
				{offHours.enabled && (
					<div className="flex gap-3">
						<Stat
							label="Window"
							value={`${offHours.start} - ${offHours.end}`}
						/>
						<Stat
							label="Started tonight"
							value={`${started} / ${offHours.maxSessions}`}
							progress={started / offHours.maxSessions}
						/>
						<Stat
							label="Picked"
							value={`${offHours.picked.length} / ${MAX_NIGHT_PICKS}`}
							progress={offHours.picked.length / MAX_NIGHT_PICKS}
						/>
					</div>
				)}
			</div>
			{lastEntry && (
				<div
					className="relative mt-5 truncate border-t border-border/60 pt-3 text-xs text-muted-foreground"
					title={lastEntry.event}
				>
					<span className="font-medium text-soft-foreground">Latest</span>{" "}
					{lastEntry.event}
				</div>
			)}
		</section>
	);
}

function Stat({
	label,
	value,
	progress,
}: {
	label: string;
	value: string;
	progress?: number;
}) {
	return (
		<div className="w-36 rounded-xl border border-border/70 bg-background/40 px-4 py-3">
			<div className="text-[11px] font-medium uppercase tracking-[.06em] text-muted-foreground">
				{label}
			</div>
			<div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
			{progress !== undefined && (
				<div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
					<div
						className="h-full rounded-full bg-primary"
						style={{ width: `${Math.min(1, progress) * 100}%` }}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * Your picks for the next run, in start order, and the waiting rows to add
 * from. The runner starts picks first, so this list is exactly what it does
 * next - then stops, or goes on down Next in line.
 */
function NextRunSection() {
	const offHours = useNextInLinePrompt((s) => s.offHours);
	const setOffHours = useNextInLinePrompt((s) => s.setOffHours);
	const { waiting } = useNextInLineQueue(true);
	const byKey = new Map(waiting.map((row) => [row.key, row]));
	const picked = offHours.picked;
	const move = (from: number, to: number) => {
		const next = [...picked];
		const [key] = next.splice(from, 1);
		if (key === undefined) return;
		next.splice(to, 0, key);
		setOffHours({ picked: next });
	};
	const addable = waiting.filter(
		(row) => canPickForTonight(row) && !picked.includes(row.key),
	);
	return (
		<>
			<SettingsSection
				title="Next run"
				description={`Started first, top to bottom, one at a time. Up to ${MAX_NIGHT_PICKS}.`}
			>
				{picked.length === 0 ? (
					<div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
						<div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
							<LuMoon className="size-5" aria-hidden />
						</div>
						<p className="text-sm font-medium">No picks yet</p>
						<p className="text-[13px] text-muted-foreground">
							Add tasks from Waiting, or click the moon on any task.
						</p>
					</div>
				) : (
					picked.map((key, i) => {
						const row = byKey.get(key);
						return (
							<div
								key={key}
								className="group flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30"
							>
								<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold tabular-nums text-primary">
									{i + 1}
								</span>
								{row ? (
									<RowTitle row={row} />
								) : (
									<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
										No longer waiting - it was started, done or removed
									</span>
								)}
								<div className="flex opacity-40 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
									<IconButton
										label="Move up"
										disabled={i === 0}
										onClick={() => move(i, i - 1)}
									>
										<LuArrowUp className="size-3.5" />
									</IconButton>
									<IconButton
										label="Move down"
										disabled={i === picked.length - 1}
										onClick={() => move(i, i + 1)}
									>
										<LuArrowDown className="size-3.5" />
									</IconButton>
									<IconButton
										label="Remove from the next run"
										onClick={() => toggleNightPick(key)}
									>
										<LuX className="size-3.5" />
									</IconButton>
								</div>
							</div>
						);
					})
				)}
				<AfterPicksRow
					value={offHours.afterPicks}
					onChange={(afterPicks) => setOffHours({ afterPicks })}
				/>
			</SettingsSection>
			<SettingsSection
				title="Waiting"
				description={`${addable.length} tasks the Night Agent can start.`}
			>
				<AddPicks rows={addable} full={picked.length >= MAX_NIGHT_PICKS} />
			</SettingsSection>
		</>
	);
}

/** What the runner does once the picks are all started. */
function AfterPicksRow({
	value,
	onChange,
}: {
	value: OffHours["afterPicks"];
	onChange: (value: OffHours["afterPicks"]) => void;
}) {
	const options: [OffHours["afterPicks"], string][] = [
		["stop", "Stop"],
		["ranked", "Go on with Next in line"],
	];
	return (
		<div className="flex items-center justify-between gap-4 px-4 py-3">
			<span className="text-sm">After the picks</span>
			<div className="flex rounded-lg border border-border p-0.5">
				{options.map(([option, label]) => (
					<button
						key={option}
						type="button"
						aria-pressed={value === option}
						onClick={() => onChange(option)}
						className={cn(
							"rounded-md px-3 py-1 text-xs transition-colors",
							value === option
								? "bg-primary/15 font-medium text-primary"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{label}
					</button>
				))}
			</div>
		</div>
	);
}

/** The waiting rows the Night Agent can start, filtered by what you type. */
function AddPicks({ rows, full }: { rows: AllItem[]; full: boolean }) {
	const [query, setQuery] = useState("");
	const nightIntro = useNightAgentIntro();
	const needle = query.trim().toLowerCase();
	const shown = needle
		? rows.filter((row) =>
				`${row.title} ${row.context ?? ""} ${row.source}`
					.toLowerCase()
					.includes(needle),
			)
		: rows;
	return (
		<div>
			{nightIntro.dialog}
			<div className="relative border-b border-border px-4 py-3">
				<LuSearch className="pointer-events-none absolute top-1/2 left-6.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search waiting tasks"
					aria-label="Search waiting tasks"
					className="h-9 pl-8 text-sm"
				/>
			</div>
			<div className="max-h-[28rem] divide-y divide-border/50 overflow-y-auto">
				{shown.length === 0 ? (
					<p className="px-4 py-4 text-center text-xs text-muted-foreground">
						{rows.length ? "No task matches." : "Nothing waiting to add."}
					</p>
				) : (
					shown.map((row) => (
						// Same grid as a pick row: a 24px lead (here +, there the number), then the title.
						<button
							key={row.key}
							type="button"
							disabled={full}
							title={
								full
									? `The next run is full (${MAX_NIGHT_PICKS})`
									: "Add to the next run"
							}
							onClick={() => nightIntro.gate(() => toggleNightPick(row.key))}
							className="group flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/30 disabled:opacity-40 disabled:hover:bg-transparent"
						>
							<span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground group-hover:border-primary/50 group-hover:bg-primary/15 group-hover:text-primary">
								<LuPlus className="size-3.5" aria-hidden />
							</span>
							<RowTitle row={row} />
						</button>
					))
				)}
			</div>
		</div>
	);
}

function RowTitle({ row }: { row: AllItem }) {
	const Icon = SOURCE_ICON[row.to];
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			{Icon && (
				<Icon
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-label={row.source}
				/>
			)}
			<span className="truncate text-sm" title={row.title}>
				{row.title}
			</span>
			{row.context && (
				<span className="shrink-0 truncate text-xs text-muted-foreground">
					{row.context}
				</span>
			)}
		</div>
	);
}

function IconButton({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
		>
			{children}
		</button>
	);
}

/** What each tick decided, newest first - the latest few unless you ask. */
function LogSection() {
	const nightLog = useNextInLinePrompt((s) => s.nightLog);
	const [showAll, setShowAll] = useState(false);
	const newestFirst = nightLog.slice().reverse();
	const shown = showAll ? newestFirst : newestFirst.slice(0, LOG_PREVIEW);
	return (
		<SettingsSection
			title="Log"
			description="What each night did, or why it didn't start."
		>
			{shown.length === 0 ? (
				<p className="px-4 py-3 text-sm text-muted-foreground">
					Nothing yet. The first night shows up here.
				</p>
			) : (
				shown.map((entry) => (
					<div
						key={`${entry.at}-${entry.event}`}
						className="flex gap-4 px-4 py-2 text-[13px] leading-relaxed"
					>
						<span className="w-24 shrink-0 tabular-nums text-xs leading-[1.6rem] text-muted-foreground">
							{new Date(entry.at).toLocaleString([], {
								month: "short",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
						<span className="cursor-text select-text">{entry.event}</span>
					</div>
				))
			)}
			{newestFirst.length > LOG_PREVIEW && (
				<button
					type="button"
					onClick={() => setShowAll(!showAll)}
					className="w-full px-4 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
				>
					{showAll ? "Show fewer" : `Show all ${newestFirst.length}`}
				</button>
			)}
		</SettingsSection>
	);
}
