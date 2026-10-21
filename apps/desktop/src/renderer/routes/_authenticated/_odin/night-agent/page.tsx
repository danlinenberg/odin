import { Input } from "@odin/ui/input";
import { Switch } from "@odin/ui/switch";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { IconType } from "react-icons";
import {
	LuArrowDown,
	LuArrowUp,
	LuArrowUpRight,
	LuChevronDown,
	LuChevronRight,
	LuMoon,
	LuPlus,
	LuSearch,
	LuX,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	canPickForTonight,
	inOffHours,
	MAX_NIGHT_PICKS,
	MAX_NIGHT_SESSIONS,
	type NightLogEntry,
	type NightStart,
	type OffHours,
	toggleNightPick,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useTabsStore } from "renderer/stores/tabs/store";
import { boardColumn } from "shared/board-column";
import type { Pane } from "shared/tabs-types";
import { NightAgentInstructionsRow } from "../../settings/backlog/page";
import { SettingsSection } from "../../settings/components/SettingsPage";
import type { AllItem } from "../all/all-items";
import { SOURCE_ICON } from "../all/TaskTable";
import { useNextInLineQueue } from "../board/NextInLine";
import { useNightAgentIntro } from "../board/NightAgentIntro";
import { FEED_TABS } from "../components/feed-counts";
import { PILL } from "../components/pill";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import { featuredNight, groupNights, type Night } from "./night-log";

export const Route = createFileRoute("/_authenticated/_odin/night-agent/")({
	component: NightAgentPage,
});

/** How many of the newest nights the log opens on; older ones fold to a line. */
const OPEN_NIGHTS = 2;

/**
 * The Night Agent's own screen: what it will do next, its schedule, its log.
 * The header holds the settings - on or off, the window, the night's cap -
 * so they are never under the log. Last night comes next: the morning's
 * question is "what ran", and the log is the detail behind it.
 */
function NightAgentPage() {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto w-full max-w-[1600px] space-y-8 px-8 py-8">
				<StatusHero />
				<LastNightSection />
				<div className="grid items-start gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
					<div className="space-y-8">
						<NextRunSection />
					</div>
					<div className="space-y-8">
						<LogSection />
						<SettingsSection title="What every session is told">
							<NightAgentInstructionsRow />
						</SettingsSection>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * On or off, whether it's running now, and how far tonight has got. The
 * switch, the window and the night's cap are edited right here: each card's
 * number is the field. They show while it's off too, to set up before turning
 * it on. Instructions have their own card under the log.
 */
function StatusHero() {
	const offHours = useNextInLinePrompt((s) => s.offHours);
	const setOffHours = useNextInLinePrompt((s) => s.setOffHours);
	const started = useNextInLinePrompt((s) => s.offHoursStarted);
	const lastEvent = useNextInLinePrompt((s) => s.nightLog.at(-1)?.event);
	const nightIntro = useNightAgentIntro();
	return (
		<>
			{nightIntro.dialog}
			<NightAgentHero
				offHours={offHours}
				started={started}
				lastEvent={lastEvent}
				onChange={setOffHours}
				// The first time it's turned on, the notice about keeping the computer awake comes first.
				onToggle={(enabled) =>
					enabled
						? nightIntro.gate(() => setOffHours({ enabled }))
						: setOffHours({ enabled })
				}
			/>
		</>
	);
}

/** The hero itself, given its state: what the page shows and the test renders. */
export function NightAgentHero({
	offHours,
	started,
	lastEvent,
	onChange,
	onToggle,
}: {
	offHours: OffHours;
	started: number;
	lastEvent: string | undefined;
	onChange: (patch: Partial<OffHours>) => void;
	onToggle: (enabled: boolean) => void;
}) {
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
						<div className="mt-0.5 flex items-center gap-3">
							<h2 className="text-2xl font-semibold tracking-tight">
								{headline}
							</h2>
							{running && (
								<span className="flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
									<span className="size-1.5 animate-pulse rounded-full bg-primary" />
									Live
								</span>
							)}
							<Switch
								aria-label={
									offHours.enabled
										? "Turn the Night Agent off"
										: "Turn the Night Agent on"
								}
								title={offHours.enabled ? "Turn off" : "Turn on"}
								checked={offHours.enabled}
								onCheckedChange={onToggle}
							/>
						</div>
						<p className="mt-1 text-sm text-muted-foreground">
							{offHours.enabled
								? "Works through your picks, then Next in line, one session at a time while you're away."
								: "Turn it on and it works through your picks, then Next in line, one session at a time while you're away."}
						</p>
					</div>
				</div>
				<div className="flex gap-3">
					<Stat label="Window">
						<TimeField
							label="Starts at"
							value={offHours.start}
							onChange={(start) => onChange({ start })}
						/>
						<span className="text-muted-foreground">-</span>
						<TimeField
							label="Ends at"
							value={offHours.end}
							onChange={(end) => onChange({ end })}
						/>
					</Stat>
					<Stat
						label="Started tonight"
						progress={started / offHours.maxSessions}
					>
						<span>{started}</span>
						<span className="text-muted-foreground">/</span>
						<CapField
							value={offHours.maxSessions}
							onChange={(maxSessions) => onChange({ maxSessions })}
						/>
					</Stat>
					<Stat
						label="Picked"
						progress={offHours.picked.length / MAX_NIGHT_PICKS}
					>
						{`${offHours.picked.length} / ${MAX_NIGHT_PICKS}`}
					</Stat>
				</div>
			</div>
			{lastEvent && (
				<div
					className="relative mt-5 truncate border-t border-border/60 pt-3 text-xs text-muted-foreground"
					title={lastEvent}
				>
					<span className="font-medium text-soft-foreground">Latest</span>{" "}
					{lastEvent}
				</div>
			)}
		</section>
	);
}

/** A label, a value line, and a bar under it when the value is a share of something. */
function Stat({
	label,
	progress,
	children,
}: {
	label: string;
	progress?: number;
	children: ReactNode;
}) {
	return (
		<div className="min-w-36 rounded-xl border border-border/70 bg-background/40 px-4 py-3">
			<div className="text-[11px] font-medium uppercase tracking-[.06em] text-muted-foreground">
				{label}
			</div>
			<div className="mt-1 flex h-7 items-center gap-1 text-lg font-semibold tabular-nums">
				{children}
			</div>
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
 * A stat's figure that is also its field: reads as the number, and gets a
 * border on hover so it's plain it can be changed. The browser's own picker
 * and spinner are hidden; type, or use the arrow keys.
 */
const FIELD =
	"h-7 rounded-md border border-transparent px-1 text-lg font-semibold tabular-nums text-foreground transition-colors hover:border-border hover:bg-background/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** One end of the window, on the same 24-hour clock the runner keeps. */
function TimeField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (next: string) => void;
}) {
	return (
		<Input
			variant="ghost"
			type="time"
			aria-label={label}
			title={label}
			value={value}
			// Chromium reports "" while a part of the time is still being typed.
			onChange={(e) => e.target.value && onChange(e.target.value)}
			className={cn(
				FIELD,
				"w-[4.5rem] [&::-webkit-calendar-picker-indicator]:hidden",
			)}
		/>
	);
}

/** The most sessions a night may start. Only whole numbers in range are saved. */
function CapField({
	value,
	onChange,
}: {
	value: number;
	onChange: (next: number) => void;
}) {
	const label = `At most this many sessions a night (1 to ${MAX_NIGHT_SESSIONS})`;
	return (
		<Input
			variant="ghost"
			type="number"
			aria-label={label}
			title={label}
			min={1}
			max={MAX_NIGHT_SESSIONS}
			step={1}
			defaultValue={value}
			onChange={(e) => {
				const next = e.target.valueAsNumber;
				if (Number.isInteger(next) && next >= 1 && next <= MAX_NIGHT_SESSIONS)
					onChange(next);
			}}
			className={cn(
				FIELD,
				"w-11 text-center [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
			)}
		/>
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

/** "23:05" - the same 24-hour clock the window is set in. */
function hhmm(iso: string): string {
	return new Date(iso).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
}

/** The feed's mark for a source name - the log keeps the name, not the path. */
const ICON_BY_SOURCE = Object.fromEntries(
	FEED_TABS.map(({ label, Icon }) => [label, Icon]),
) as Record<string, IconType | undefined>;

/** The log by night, and the night to lead with. Re-labelled each minute, the runner's own tick. */
function useNights() {
	const nightLog = useNextInLinePrompt((s) => s.nightLog);
	const start = useNextInLinePrompt((s) => s.offHours.start);
	const end = useNextInLinePrompt((s) => s.offHours.end);
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 60_000);
		return () => clearInterval(id);
	}, []);
	return useMemo(() => {
		const nights = groupNights(nightLog, start, end, now);
		return { nights, featured: featuredNight(nights, start, end, now) };
	}, [nightLog, start, end, now]);
}

/**
 * What the last window started - the morning's question - and where each
 * session stands now. Tonight's, while the window is open. A row opens the
 * session: on the board, or in Session History once it's Done.
 */
function LastNightSection() {
	const hasLog = useNextInLinePrompt((s) => s.nightLog.length > 0);
	const start = useNextInLinePrompt((s) => s.offHours.start);
	const end = useNextInLinePrompt((s) => s.offHours.end);
	const { featured: night } = useNights();
	if (!hasLog) return null;
	const count = night.started.length;
	const when = `${night.date}, ${start} to ${end}`;
	return (
		<SettingsSection
			title={night.label === "Tonight" ? "Tonight so far" : "Last night"}
			description={
				count
					? `${when}: ${count} session${count === 1 ? "" : "s"} started, in order. Click one to open it.`
					: `${when}: nothing started.`
			}
		>
			{count ? <StartedRows night={night} /> : <EmptyNight night={night} />}
		</SettingsSection>
	);
}

/** Why a night started nothing: its last two lines, or that it has none. */
function EmptyNight({ night }: { night: Night }) {
	if (night.lines.length === 0)
		return (
			<p className="px-4 py-3 text-sm text-muted-foreground">
				Nothing in the log for this night: Odin wasn't open, or the computer was
				asleep. Sessions the remote host ran show up a few minutes after Odin
				opens.
			</p>
		);
	return night.lines.slice(0, 2).map((entry) => (
		<div
			key={`${entry.at}-${entry.event}`}
			className="flex gap-3 px-4 py-2 text-[13px]"
		>
			<span className="w-10 shrink-0 text-right text-xs leading-5 tabular-nums text-muted-foreground">
				{hhmm(entry.at)}
			</span>
			<span className="cursor-text select-text leading-5 text-muted-foreground">
				{entry.event}
			</span>
		</div>
	));
}

/** Where a started session stands now: the board's column, or Done once it's gone. */
function sessionState(
	pane: Pane | undefined,
	alive: Set<string> | undefined,
): { dot: string; label: string } {
	if (!pane || pane.completed) return { dot: "var(--success)", label: "Done" };
	return PANE_STATUS[
		boardColumn(
			pane.status ?? "idle",
			alive?.has(pane.id),
			pane.odinParked ?? false,
			false,
			pane.odinClosedIn,
		)
	];
}

function StartedRows({ night }: { night: Night }) {
	const panes = useTabsStore((s) => s.panes);
	// The board's own 5s poll - one shared query - so a dead session reads Idle, not Working.
	const { data: daemon } = electronTrpc.terminal.listDaemonSessions.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);
	const alive = useMemo(
		() =>
			daemon &&
			new Set(
				daemon.sessions
					.filter((session) => session.isAlive)
					.map((session) => session.sessionId),
			),
		[daemon],
	);
	const bySession = useMemo(
		() =>
			new Map(
				Object.values(panes).flatMap((pane) =>
					pane.claudeSessionId ? [[pane.claudeSessionId, pane] as const] : [],
				),
			),
		[panes],
	);
	return night.started.map(
		(entry, i) =>
			entry.started && (
				<StartedRow
					key={`${entry.at}-${entry.started.key}`}
					index={i}
					entry={entry}
					started={entry.started}
					pane={bySession.get(entry.started.sessionId ?? "")}
					alive={alive}
				/>
			),
	);
}

function StartedRow({
	index,
	entry,
	started,
	pane,
	alive,
}: {
	index: number;
	entry: NightLogEntry;
	started: NightStart;
	pane: Pane | undefined;
	alive: Set<string> | undefined;
}) {
	const navigate = useNavigate();
	const state = sessionState(pane, alive);
	const Icon = ICON_BY_SOURCE[started.source];
	const onBoard = !!pane && !pane.completed;
	const canOpen = onBoard || !!started.sessionId;
	const open = () => {
		if (pane && onBoard) {
			usePendingFocus.getState().focus(pane.id);
			void navigate({ to: "/board" });
		} else if (started.sessionId)
			void navigate({
				to: "/sessions",
				search: { q: started.title, open: started.sessionId },
			});
	};
	return (
		<button
			type="button"
			disabled={!canOpen}
			onClick={open}
			title={onBoard ? "Open on the board" : "Open in Session History"}
			className="group flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/30 disabled:cursor-default disabled:hover:bg-transparent"
		>
			<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold tabular-nums text-primary">
				{index + 1}
			</span>
			{Icon && (
				<Icon
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-label={started.source}
				/>
			)}
			<span className="min-w-0 flex-1 truncate text-sm" title={started.title}>
				{started.title}
			</span>
			<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
				{hhmm(entry.at)}
			</span>
			<span
				className={cn(
					"flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
					PILL.neutral,
				)}
			>
				<span
					className="size-1.5 rounded-full"
					style={{ background: state.dot }}
					aria-hidden
				/>
				{state.label}
			</span>
			<LuArrowUpRight
				className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-disabled:opacity-0"
				aria-hidden
			/>
		</button>
	);
}

/**
 * What each tick decided, by night, newest first. The newest two nights are
 * open; an older one folds to its header until you click it.
 */
function LogSection() {
	const { nights } = useNights();
	const [toggled, setToggled] = useState<Record<number, boolean>>({});
	const isOpen = (night: Night, i: number) =>
		toggled[night.from] ?? i < OPEN_NIGHTS;
	return (
		<SettingsSection
			title="Log"
			description="What each night did, or why it didn't start."
		>
			{nights.length === 0 ? (
				<p className="px-4 py-3 text-sm text-muted-foreground">
					Nothing yet. The first night shows up here.
				</p>
			) : (
				nights.map((night, i) => (
					<NightGroup
						key={night.from}
						night={night}
						open={isOpen(night, i)}
						onToggle={() =>
							setToggled({ ...toggled, [night.from]: !isOpen(night, i) })
						}
					/>
				))
			)}
		</SettingsSection>
	);
}

/** One night: a header line to fold it by, then its lines down a rail. */
function NightGroup({
	night,
	open,
	onToggle,
}: {
	night: Night;
	open: boolean;
	onToggle: () => void;
}) {
	const Chevron = open ? LuChevronDown : LuChevronRight;
	const count = night.started.length;
	return (
		<div>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-muted/30"
			>
				<Chevron
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-hidden
				/>
				<LuMoon
					className={cn(
						"size-3.5 shrink-0",
						count ? "text-primary" : "text-muted-foreground",
					)}
					aria-hidden
				/>
				<span className="text-sm font-medium">{night.label}</span>
				{night.label !== night.date && (
					<span className="text-xs text-muted-foreground">{night.date}</span>
				)}
				<span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
					{count ? `${count} started` : "nothing started"}
				</span>
			</button>
			{open && (
				<div className="relative pb-2">
					<div
						className="absolute inset-y-0 left-[4.625rem] w-px bg-border/70"
						aria-hidden
					/>
					{night.lines.map((entry) => (
						<LogLine key={`${entry.at}-${entry.event}`} entry={entry} />
					))}
				</div>
			)}
		</div>
	);
}

/** Time, a dot on the rail, the line. A start is lit; the rest is quiet. */
function LogLine({ entry }: { entry: NightLogEntry }) {
	return (
		<div className="relative flex items-start gap-3 px-4 py-1">
			<span className="w-10 shrink-0 text-right text-xs leading-5 tabular-nums text-muted-foreground">
				{hhmm(entry.at)}
			</span>
			<span className="flex h-5 w-3 shrink-0 items-center justify-center">
				<span
					className={cn(
						"relative size-1.5 rounded-full",
						entry.started
							? "bg-primary glow-primary"
							: "bg-border ring-2 ring-card",
					)}
				/>
			</span>
			<span
				className={cn(
					"min-w-0 flex-1 cursor-text select-text text-[13px] leading-5",
					entry.started ? "text-foreground" : "text-muted-foreground",
				)}
			>
				{entry.event}
			</span>
		</div>
	);
}
