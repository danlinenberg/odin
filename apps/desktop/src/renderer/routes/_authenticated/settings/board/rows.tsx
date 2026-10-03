import { ODIN_AUTO_RENAME_SESSIONS_DEFAULT } from "@odin/shared/constants";
import { Input } from "@odin/ui/input";
import { Label } from "@odin/ui/label";
import { Switch } from "@odin/ui/switch";
import { Textarea } from "@odin/ui/textarea";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useIdleClose } from "renderer/stores/idle-close";
import { useLaunchLimits } from "renderer/stores/launch-limits";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import type { LaunchLimits } from "shared/machine-load";
import { useReminders } from "../../_odin/components/Reminders";
import { useBacklogReview } from "../../_odin/hooks/useBacklogReview";

/**
 * One Board settings page: every setting on these is Odin's own and shows in
 * every variant, so no item-visibility plumbing.
 */
export function BoardSettingsPage({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: React.ReactNode;
}) {
	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">{title}</h2>
				<p className="text-sm text-muted-foreground mt-1">{description}</p>
			</div>
			<div className="space-y-8">{children}</div>
		</div>
	);
}

/** Name each card after what its session turned out to be about. */
export function AutoRenameRow() {
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
		<div className="flex items-center justify-between">
			<div className="space-y-0.5">
				<Label htmlFor="auto-rename-sessions" className="text-sm font-medium">
					Rename sessions automatically
				</Label>
				<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
					Name each card after what its session turned out to be about, not the
					first line you typed. Happens once; names you set yourself are kept.
				</p>
			</div>
			<Switch
				id="auto-rename-sessions"
				checked={autoRename ?? ODIN_AUTO_RENAME_SESSIONS_DEFAULT}
				onCheckedChange={(enabled) => setAutoRename.mutate({ enabled })}
				disabled={isLoading || setAutoRename.isPending}
			/>
		</div>
	);
}

/**
 * Your own words for how the board's Next in line column is sorted. Saved on
 * blur, not per keystroke: every change re-ranks, and a ranking is a ~75s
 * model call.
 */
export function NextInLinePromptRow() {
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
export function LaunchLimitRow({
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
	field: Exclude<keyof LaunchLimits, "oneSessionPerCheckout">;
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

/** Hold a second session out of a checkout one is already working in. */
export function OneSessionPerCheckoutRow() {
	const enabled = useLaunchLimits((s) => s.oneSessionPerCheckout !== false);
	const setLimits = useLaunchLimits((s) => s.setLimits);
	return (
		<div className="flex items-center justify-between gap-6">
			<div className="space-y-0.5">
				<Label
					htmlFor="one-session-per-checkout"
					className="text-sm font-medium"
				>
					One session per repo at a time
				</Label>
				<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
					A session started in a repo another one is working in waits in Queued
					until that one stops. Off lets them run side by side — they share one
					working tree, so each sees the other's edits.
				</p>
			</div>
			<Switch
				id="one-session-per-checkout"
				checked={enabled}
				onCheckedChange={(on) => setLimits({ oneSessionPerCheckout: on })}
			/>
		</div>
	);
}

/** How far overdue a task can be and still pin under Next in line's Due. */
export function PinOverdueDaysRow() {
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

/** When the day's reminder and due-date banner goes out. Next minute tick. */
export function NotifyAtRow() {
	const notifyAt = useReminders((s) => s.notifyAt);
	const setNotifyAt = useReminders((s) => s.setNotifyAt);
	return (
		<div className="flex items-center justify-between gap-6">
			<div className="space-y-0.5">
				<Label htmlFor="reminder-notify-at" className="text-sm font-medium">
					Notify at
				</Label>
				<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
					When "Remind me" sessions and due dates notify, on their day. All of a
					day's reminders arrive as one notification. The board shows them from
					midnight.
				</p>
			</div>
			<Input
				id="reminder-notify-at"
				type="time"
				defaultValue={notifyAt}
				className="w-28 shrink-0 tabular-nums"
				style={{ colorScheme: "dark" }}
				onChange={(event) => {
					if (event.target.value) setNotifyAt(event.target.value);
				}}
			/>
		</div>
	);
}

/** How often the shell runs the Review sweep on its own. Next tick, no restart. */
export function SweepIntervalRow() {
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

/**
 * Night Agent: Next in line worked through overnight, one session at a time.
 * Every control saves as you change it; the runner reads them each minute.
 */
export function NightAgentRows() {
	const offHours = useNextInLinePrompt((s) => s.offHours);
	const setOffHours = useNextInLinePrompt((s) => s.setOffHours);
	const started = useNextInLinePrompt((s) => s.offHoursStarted);
	const [draft, setDraft] = useState(offHours.instructions);
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-6">
				<div className="space-y-0.5">
					<Label htmlFor="night-agent" className="text-sm font-medium">
						Work the backlog overnight
					</Label>
					<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
						Between these times, Odin starts the top of Next in line, waits for
						that session to finish its turn, then starts the next. Their cards
						wear a Night Agent pill. Odin has to be open; the Mac awake.
						{offHours.enabled && started > 0 && ` ${started} started tonight.`}
					</p>
				</div>
				<Switch
					id="night-agent"
					checked={offHours.enabled}
					onCheckedChange={(enabled) => setOffHours({ enabled })}
				/>
			</div>
			<div className="flex items-center gap-3 text-sm">
				<Label htmlFor="night-agent-start">From</Label>
				<Input
					id="night-agent-start"
					type="time"
					value={offHours.start}
					onChange={(e) =>
						e.target.value && setOffHours({ start: e.target.value })
					}
					className="w-28 tabular-nums"
				/>
				<Label htmlFor="night-agent-end">to</Label>
				<Input
					id="night-agent-end"
					type="time"
					value={offHours.end}
					onChange={(e) =>
						e.target.value && setOffHours({ end: e.target.value })
					}
					className="w-28 tabular-nums"
				/>
				<Label htmlFor="night-agent-max" className="ml-4">
					At most
				</Label>
				<Input
					id="night-agent-max"
					type="number"
					min={1}
					max={50}
					defaultValue={offHours.maxSessions}
					className="w-20 tabular-nums"
					onChange={(event) => {
						const next = event.target.valueAsNumber;
						if (Number.isInteger(next) && next >= 1 && next <= 50)
							setOffHours({ maxSessions: next });
					}}
				/>
				<span className="text-muted-foreground">sessions a night</span>
			</div>
			<div className="space-y-1">
				<Label
					htmlFor="night-agent-instructions"
					className="text-sm font-medium"
				>
					Night Agent instructions
				</Label>
				<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
					Handed to every Night Agent session, and used to pick them: "don't
					include X" keeps X out of the night's queue. An edit applies from the
					next session on.
				</p>
				<Textarea
					id="night-agent-instructions"
					value={draft}
					onChange={(e) => {
						setDraft(e.target.value);
						setOffHours({ instructions: e.target.value.trim() });
					}}
					maxLength={4000}
					rows={4}
				/>
			</div>
		</div>
	);
}

/** When the board closes a session that's sat idle. Next minute's sweep. */
export function IdleCloseRow() {
	const hours = useIdleClose((s) => s.hours);
	const setHours = useIdleClose((s) => s.setHours);
	return (
		<div className="flex items-center justify-between gap-6">
			<div className="space-y-0.5">
				<Label htmlFor="idle-close-hours" className="text-sm font-medium">
					Close idle sessions after
				</Label>
				<p className="text-[13px] leading-relaxed text-muted-foreground max-w-xl">
					A session out of Working this long, with nothing running in its shell,
					is closed. Its card stays in its column; Resume reopens it. 0 never
					closes.
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				<Input
					id="idle-close-hours"
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
