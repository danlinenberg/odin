import { createFileRoute } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";

export const Route = createFileRoute("/_authenticated/_odin/insights/")({
	component: InsightsPage,
});

/**
 * Insights — what lands on you, and what you do with it.
 *
 * Deliberately arithmetic, not a model call: these are questions with exact
 * answers, and a summary you have to wait fifteen seconds for is one you stop
 * opening. Everything is scoped to the active profile.
 */

const SOURCE_LABEL: Record<string, string> = {
	reactions: "Slack",
	jira: "Jira",
	pr: "GitHub",
	notion: "Notion",
};

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
		<div className="flex min-w-[120px] flex-1 flex-col gap-1 rounded-[10px] border border-[#25252e] bg-[#111114] px-3.5 py-3">
			<div className="text-[22px] font-semibold leading-none text-[#f5f5f7]">
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
}: {
	name: string;
	count: number;
	max: number;
}) {
	return (
		<div className="flex items-center gap-3">
			<div className="w-[150px] shrink-0 truncate text-[12px] text-[#d6d6dc]">
				{name}
			</div>
			<div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[#1b1b22]">
				<div
					className="h-full rounded-full bg-[#a394ff]"
					style={{ width: `${Math.max(4, (count / max) * 100)}%` }}
				/>
			</div>
			<div className="w-6 shrink-0 text-right text-[11.5px] text-[#a5a5b3]">
				{count}
			</div>
		</div>
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
		</div>
	);
}
