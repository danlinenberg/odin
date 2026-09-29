import { createFileRoute } from "@tanstack/react-router";
import { BoardSettingsPage, LaunchLimitRow } from "../board/rows";

export const Route = createFileRoute("/_authenticated/settings/launch-limits/")(
	{
		component: LaunchLimitsSettingsPage,
	},
);

function LaunchLimitsSettingsPage() {
	return (
		<BoardSettingsPage
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
		</BoardSettingsPage>
	);
}
