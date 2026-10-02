import { createFileRoute } from "@tanstack/react-router";
import { BoardSettingsPage, NightAgentRows } from "../board/rows";

export const Route = createFileRoute("/_authenticated/settings/night-agent/")({
	component: NightAgentSettingsPage,
});

function NightAgentSettingsPage() {
	return (
		<BoardSettingsPage
			title="Night Agent"
			description="Work through Next in line overnight, one session at a time, while you're away"
		>
			<NightAgentRows />
		</BoardSettingsPage>
	);
}
