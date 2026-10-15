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
import {
	SettingsPage,
	SettingsSection,
} from "../../settings/components/SettingsPage";
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
			<SettingsPage
				title="Night Agent"
				description="Works through your picks, then Next in line, one session at a time while you're away."
			>
				<StatusCard />
				<NextRunSection />
				<SettingsSection title="Schedule">
					<NightAgentRows />
				</SettingsSection>
				<LogSection />
			</SettingsPage>
		</div>
	);
}

/** On or off, whether it's running now, and how far tonight has got. */
function StatusCard() {
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
		<div className="flex items-center gap-4 rounded-xl border border-border bg-card/60 px-5 py-4">
			<div
				className={cn(
					"flex size-11 shrink-0 items-center justify-center rounded-full",
					offHours.enabled
						? "bg-primary/15 text-primary"
						: "bg-muted text-muted-foreground",
				)}
			>
				<LuMoon className="size-5" aria-hidden />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="text-base font-semibold">{headline}</span>
					{running && (
						<span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
							Live
						</span>
					)}
				</div>
				<div className="mt-0.5 text-[13px] text-muted-foreground">
					{offHours.enabled
						? `${offHours.start} - ${offHours.end} · ${started} of at most ${offHours.maxSessions} started tonight · ${offHours.picked.length} picked`
						: "Turn it on under Schedule below."}
				</div>
				{lastEntry && (
					<div
						className="mt-1 truncate text-xs text-soft-foreground"
						title={lastEntry.event}
					>
						Last: {lastEntry.event}
					</div>
				)}
			</div>
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
	return (
		<SettingsSection
			title="Next run"
			description={`Started first, top to bottom, one at a time. Up to ${MAX_NIGHT_PICKS}.`}
		>
			{picked.length === 0 ? (
				<p className="px-4 py-4 text-sm text-muted-foreground">
					No picks yet. Add tasks below, or click the moon on any task.
				</p>
			) : (
				picked.map((key, i) => {
					const row = byKey.get(key);
					return (
						<div key={key} className="flex items-center gap-3 px-4 py-2.5">
							<span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
								{i + 1}
							</span>
							{row ? (
								<RowTitle row={row} />
							) : (
								<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
									No longer waiting - it was started, done or removed
								</span>
							)}
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
					);
				})
			)}
			<AfterPicksRow
				value={offHours.afterPicks}
				onChange={(afterPicks) => setOffHours({ afterPicks })}
			/>
			<AddPicks
				rows={waiting.filter(
					(row) => canPickForTonight(row) && !picked.includes(row.key),
				)}
				full={picked.length >= MAX_NIGHT_PICKS}
			/>
		</SettingsSection>
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
		<div className="px-4 py-3">
			{nightIntro.dialog}
			<div className="relative">
				<LuSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={`Add from ${rows.length} waiting tasks`}
					aria-label="Search waiting tasks"
					className="h-8 pl-8 text-sm"
				/>
			</div>
			<div className="mt-2 max-h-72 overflow-y-auto">
				{shown.length === 0 ? (
					<p className="py-3 text-center text-xs text-muted-foreground">
						{rows.length ? "No task matches." : "Nothing waiting to add."}
					</p>
				) : (
					shown.map((row) => (
						<div
							key={row.key}
							className="flex items-center gap-3 rounded-md px-1 py-1.5 hover:bg-muted/40"
						>
							<RowTitle row={row} />
							<button
								type="button"
								disabled={full}
								title={
									full
										? `The next run is full (${MAX_NIGHT_PICKS})`
										: "Add to the next run"
								}
								onClick={() => nightIntro.gate(() => toggleNightPick(row.key))}
								className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-primary/15 hover:text-primary disabled:opacity-40"
							>
								<LuPlus className="size-3" aria-hidden />
								Add
							</button>
						</div>
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
						className="flex gap-4 px-4 py-2 text-sm"
					>
						<span className="w-28 shrink-0 tabular-nums text-muted-foreground">
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
