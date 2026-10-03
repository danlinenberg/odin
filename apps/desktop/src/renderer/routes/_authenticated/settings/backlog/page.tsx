import { Input } from "@odin/ui/input";
import { Label } from "@odin/ui/label";
import { Switch } from "@odin/ui/switch";
import { Textarea } from "@odin/ui/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import { useBacklogReview } from "../../_odin/hooks/useBacklogReview";
import {
	NumberSetting,
	SettingRow,
	SettingsPage,
	SettingsSection,
} from "../components/SettingsPage";

export const Route = createFileRoute("/_authenticated/settings/backlog/")({
	component: BacklogSettingsPage,
});

function BacklogSettingsPage() {
	return (
		<SettingsPage
			title="Backlog"
			description="Tasks nobody has started yet: how Next in line orders them, what the Night Agent works through, and how often Review re-checks them."
		>
			<SettingsSection
				title="Next in line"
				description="The board column the AI fills with what to start next."
			>
				<NextInLinePromptRow />
				<PinOverdueDaysRow />
			</SettingsSection>

			<SettingsSection
				title="Night Agent"
				description="Works through Next in line overnight, one session at a time, while you're away."
			>
				<NightAgentRows />
			</SettingsSection>

			<SettingsSection
				title="Review"
				description="The sweep that re-checks the backlog and fills the Review screen."
			>
				<SweepIntervalRow />
			</SettingsSection>
		</SettingsPage>
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
		<SettingRow
			label="How to sort it"
			htmlFor="next-in-line-prompt"
			description={`What matters to you when the AI orders this column — e.g. "customer bugs first; ignore dependency bumps". Empty lets the AI judge. Saved when you click away.`}
			stacked
		>
			<Textarea
				id="next-in-line-prompt"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => setPrompt(draft.trim())}
				maxLength={4000}
				rows={4}
				placeholder="Customer-facing bugs first, then anything someone is waiting on me for…"
			/>
		</SettingRow>
	);
}

/** How far overdue a task can be and still pin under Next in line's Due. */
function PinOverdueDaysRow() {
	const days = useNextInLinePrompt((s) => s.pinOverdueDays);
	const setDays = useNextInLinePrompt((s) => s.setPinOverdueDays);
	return (
		<SettingRow
			label="Pin overdue tasks for"
			htmlFor="pin-overdue-days"
			description="Dated tasks pin to the top under Due. Once more than this overdue, they drop back into the normal order. Upcoming dates always pin."
		>
			<NumberSetting
				id="pin-overdue-days"
				value={days}
				min={0}
				max={3650}
				step={1}
				unit="days"
				onChange={setDays}
			/>
		</SettingRow>
	);
}

/** Every control saves as you change it; the runner reads them each minute. */
function NightAgentRows() {
	const offHours = useNextInLinePrompt((s) => s.offHours);
	const setOffHours = useNextInLinePrompt((s) => s.setOffHours);
	const started = useNextInLinePrompt((s) => s.offHoursStarted);
	const [draft, setDraft] = useState(offHours.instructions);
	return (
		<>
			<SettingRow
				label="Work the backlog overnight"
				htmlFor="night-agent"
				description={
					<>
						Starts the top of Next in line, waits for that session to finish its
						turn, then starts the next. Their cards wear a Night Agent pill.
						Odin has to be open and the Mac awake.
						{offHours.enabled && started > 0 && ` ${started} started tonight.`}
					</>
				}
			>
				<Switch
					id="night-agent"
					checked={offHours.enabled}
					onCheckedChange={(enabled) => setOffHours({ enabled })}
				/>
			</SettingRow>
			<SettingRow
				label="Hours"
				htmlFor="night-agent-start"
				description="It only starts sessions inside this window."
			>
				<Input
					id="night-agent-start"
					type="time"
					value={offHours.start}
					onChange={(e) =>
						e.target.value && setOffHours({ start: e.target.value })
					}
					className="w-28 tabular-nums"
				/>
				<Label
					htmlFor="night-agent-end"
					className="px-1 text-sm text-muted-foreground"
				>
					to
				</Label>
				<Input
					id="night-agent-end"
					type="time"
					value={offHours.end}
					onChange={(e) =>
						e.target.value && setOffHours({ end: e.target.value })
					}
					className="w-28 tabular-nums"
				/>
			</SettingRow>
			<SettingRow
				label="At most"
				htmlFor="night-agent-max"
				description="Sessions it starts in one night."
			>
				<NumberSetting
					id="night-agent-max"
					value={offHours.maxSessions}
					min={1}
					max={50}
					step={1}
					unit="sessions"
					onChange={(next) =>
						Number.isInteger(next) && setOffHours({ maxSessions: next })
					}
				/>
			</SettingRow>
			<SettingRow
				label="Instructions"
				htmlFor="night-agent-instructions"
				description={`Handed to every Night Agent session, and used to pick them: "don't include X" keeps X out of the night's queue. An edit applies from the next session on.`}
				stacked
			>
				<Textarea
					id="night-agent-instructions"
					value={draft}
					onChange={(e) => {
						setDraft(e.target.value);
						setOffHours({ instructions: e.target.value.trim() });
					}}
					maxLength={4000}
					rows={6}
				/>
			</SettingRow>
		</>
	);
}

/** How often the shell runs the Review sweep on its own. Next tick, no restart. */
function SweepIntervalRow() {
	const hours = useBacklogReview((s) => s.sweepEveryHours);
	const setHours = useBacklogReview((s) => s.setSweepEveryHours);
	return (
		<SettingRow
			label="Sweep the backlog every"
			htmlFor="sweep-every-hours"
			description="Checks tasks and queued messages against Jira, GitHub and Slack to fill Review. 0 turns it off; the button on Review still works."
		>
			<NumberSetting
				id="sweep-every-hours"
				value={hours}
				min={0}
				max={168}
				step={0.5}
				unit="hours"
				onChange={setHours}
			/>
		</SettingRow>
	);
}
