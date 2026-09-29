import { ODIN_AUTO_RENAME_SESSIONS_DEFAULT } from "@odin/shared/constants";
import { Input } from "@odin/ui/input";
import { Label } from "@odin/ui/label";
import { Switch } from "@odin/ui/switch";
import { Textarea } from "@odin/ui/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useLaunchLimits } from "renderer/stores/launch-limits";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import type { LaunchLimits } from "shared/machine-load";
import { useBacklogReview } from "../../_odin/hooks/useBacklogReview";

export const Route = createFileRoute("/_authenticated/settings/board/")({
	component: BoardSettingsPage,
});

/**
 * The board's own settings — no item-visibility plumbing, because every
 * setting on this page is Odin's own and shows in every variant.
 */
function BoardSettingsPage() {
	const utils = electronTrpc.useUtils();
	const { data: autoRename, isLoading } =
		electronTrpc.settings.getOdinAutoRenameSessions.useQuery();
	const setAutoRename =
		electronTrpc.settings.setOdinAutoRenameSessions.useMutation({
			onMutate: async ({ enabled }) => {
				await utils.settings.getOdinAutoRenameSessions.cancel();
				const previous = utils.settings.getOdinAutoRenameSessions.getData();
				utils.settings.getOdinAutoRenameSessions.setData(undefined, enabled);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getOdinAutoRenameSessions.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => utils.settings.getOdinAutoRenameSessions.invalidate(),
		});

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Board</h2>
				<p className="text-sm text-muted-foreground mt-1">
					How the board names, shows and starts your sessions
				</p>
			</div>

			<div className="space-y-10">
				<BoardSection title="Cards">
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label
								htmlFor="auto-rename-sessions"
								className="text-sm font-medium"
							>
								Rename sessions automatically
							</Label>
							<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
								Name each card after what its session turned out to be about,
								not the first line you typed. Happens once; names you set
								yourself are kept.
							</p>
						</div>
						<Switch
							id="auto-rename-sessions"
							checked={autoRename ?? ODIN_AUTO_RENAME_SESSIONS_DEFAULT}
							onCheckedChange={(enabled) => setAutoRename.mutate({ enabled })}
							disabled={isLoading || setAutoRename.isPending}
						/>
					</div>
				</BoardSection>

				<BoardSection
					title="Launch limits"
					description="When a new session waits in Idle → Queued instead of starting"
				>
					<LaunchLimitRow
						id="launch-limit-host"
						field="hostCpuPercent"
						label="Hold new sessions when this Mac is"
						description="Total CPU load — Odin's sessions, builds, Docker, anything. Lower it if the Mac feels slow before sessions start queueing."
						min={1}
						max={100}
						step={1}
						unit="%"
					/>
					<LaunchLimitRow
						id="launch-limit-memory"
						field="minFreeMemoryGb"
						label="Hold new sessions when free memory is under"
						description="Memory still available, cache included. A Mac out of memory swaps and crawls even when the CPU looks idle."
						min={0}
						max={64}
						step={0.5}
						unit="GB"
					/>
					<LaunchLimitRow
						id="launch-limit-agents"
						field="maxWorkingAgents"
						label="Hold new sessions when this many are working"
						description="Sessions waiting on you don't count. 0 means no limit."
						min={0}
						max={50}
						step={1}
						unit="sessions"
					/>
				</BoardSection>

				<BoardSection title="Next in line">
					<NextInLinePromptRow />
					<PinOverdueDaysRow />
				</BoardSection>

				<BoardSection title="Review">
					<SweepIntervalRow />
				</BoardSection>
			</div>
		</div>
	);
}

function BoardSection({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-6">
			<div className="border-b pb-2">
				<h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
					{title}
				</h3>
				{description && (
					<p className="text-sm text-muted-foreground/80 mt-1">{description}</p>
				)}
			</div>
			{children}
		</section>
	);
}

/**
 * Your own words for how the board's Next in line column is sorted. Saved on
 * blur, not per keystroke: every change re-ranks, and a ranking is a ~75s
 * model call.
 */
function NextInLinePromptRow() {
	const prompt = useNextInLinePrompt((s) => s.prompt);
	const setPrompt = useNextInLinePrompt((s) => s.setPrompt);
	const [draft, setDraft] = useState(prompt);
	return (
		<div className="space-y-2">
			<div className="space-y-0.5">
				<Label htmlFor="next-in-line-prompt" className="text-sm font-medium">
					How to sort Next in line
				</Label>
				<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
					What matters to you when the AI orders this column — e.g. "customer
					bugs first; ignore dependency bumps". Empty lets the AI judge. Saved
					when you click away.
				</p>
			</div>
			<Textarea
				id="next-in-line-prompt"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => setPrompt(draft.trim())}
				maxLength={4000}
				rows={5}
				placeholder="Customer-facing bugs first, then anything someone is waiting on me for…"
			/>
		</div>
	);
}

/**
 * One launch-gate limit. Takes effect on the next queue tick (5s) and the
 * next launch; no restart.
 */
function LaunchLimitRow({
	id,
	field,
	label,
	description,
	min,
	max,
	step,
	unit,
}: {
	id: string;
	field: keyof LaunchLimits;
	label: string;
	description: string;
	min: number;
	max: number;
	step: number;
	unit: string;
}) {
	const value = useLaunchLimits((s) => s[field]);
	const setLimits = useLaunchLimits((s) => s.setLimits);
	return (
		<div className="flex items-center justify-between gap-6">
			<div className="space-y-0.5">
				<Label htmlFor={id} className="text-sm font-medium">
					{label}
				</Label>
				<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
					{description}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<Input
					id={id}
					type="number"
					min={min}
					max={max}
					step={step}
					defaultValue={value}
					className="w-20 tabular-nums"
					onChange={(event) => {
						const next = event.target.valueAsNumber;
						// ponytail: an empty or out-of-range box keeps the last good
						// value rather than arguing — the field is the only place to fix it.
						if (Number.isFinite(next) && next >= min && next <= max) {
							setLimits({ [field]: next });
						}
					}}
				/>
				<span className="w-16 text-sm text-muted-foreground">{unit}</span>
			</div>
		</div>
	);
}

/** How far overdue a task can be and still pin under Next in line's Due. */
function PinOverdueDaysRow() {
	const days = useNextInLinePrompt((s) => s.pinOverdueDays);
	const setDays = useNextInLinePrompt((s) => s.setPinOverdueDays);
	return (
		<div className="flex items-center justify-between gap-6">
			<div className="space-y-0.5">
				<Label htmlFor="pin-overdue-days" className="text-sm font-medium">
					Pin overdue tasks for
				</Label>
				<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
					Dated tasks pin to the top under Due. Once more than this overdue,
					they drop back into the normal order. Upcoming dates always pin.
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<Input
					id="pin-overdue-days"
					type="number"
					min={0}
					max={3650}
					step={1}
					defaultValue={days}
					className="w-20 tabular-nums"
					onChange={(event) => {
						const next = event.target.valueAsNumber;
						// ponytail: same as LaunchLimitRow — a bad value keeps the last good one.
						if (Number.isFinite(next) && next >= 0 && next <= 3650)
							setDays(next);
					}}
				/>
				<span className="w-16 text-sm text-muted-foreground">days</span>
			</div>
		</div>
	);
}

/** How often the shell runs the Review sweep on its own. Next tick, no restart. */
function SweepIntervalRow() {
	const hours = useBacklogReview((s) => s.sweepEveryHours);
	const setHours = useBacklogReview((s) => s.setSweepEveryHours);
	return (
		<div className="flex items-center justify-between gap-6">
			<div className="space-y-0.5">
				<Label htmlFor="sweep-every-hours" className="text-sm font-medium">
					Sweep the backlog every
				</Label>
				<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
					Checks tasks and queued messages against Jira, GitHub and Slack to
					fill Review. 0 turns it off; the button still works.
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<Input
					id="sweep-every-hours"
					type="number"
					min={0}
					max={168}
					step={0.5}
					defaultValue={hours}
					className="w-20 tabular-nums"
					onChange={(event) => {
						const next = event.target.valueAsNumber;
						// ponytail: same as LaunchLimitRow — a bad value keeps the last good one.
						if (Number.isFinite(next) && next >= 0 && next <= 168)
							setHours(next);
					}}
				/>
				<span className="w-16 text-sm text-muted-foreground">hours</span>
			</div>
		</div>
	);
}
