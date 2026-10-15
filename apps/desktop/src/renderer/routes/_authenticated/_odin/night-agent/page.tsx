import { createFileRoute } from "@tanstack/react-router";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import { NightAgentRows } from "../../settings/backlog/page";
import {
	SettingsPage,
	SettingsSection,
} from "../../settings/components/SettingsPage";

export const Route = createFileRoute("/_authenticated/_odin/night-agent/")({
	component: NightAgentPage,
});

/** The Night Agent's own screen: the same controls as Settings, plus its log. */
function NightAgentPage() {
	const nightLog = useNextInLinePrompt((s) => s.nightLog);
	return (
		<div className="h-full overflow-y-auto">
			<SettingsPage
				title="Night Agent"
				description="Works through Next in line overnight, one session at a time, while you're away."
			>
				<SettingsSection title="Schedule">
					<NightAgentRows />
				</SettingsSection>
				<SettingsSection
					title="Log"
					description="What each night did, or why it didn't start. Newest first."
				>
					{nightLog.length === 0 ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">
							Nothing yet. The first night shows up here.
						</p>
					) : (
						nightLog
							.slice()
							.reverse()
							.map((entry) => (
								<div
									key={`${entry.at}-${entry.event}`}
									className="flex gap-4 px-4 py-2 text-sm"
								>
									<span className="shrink-0 tabular-nums text-muted-foreground">
										{new Date(entry.at).toLocaleString([], {
											month: "short",
											day: "numeric",
											hour: "2-digit",
											minute: "2-digit",
										})}
									</span>
									<span className="select-text">{entry.event}</span>
								</div>
							))
					)}
				</SettingsSection>
			</SettingsPage>
		</div>
	);
}
