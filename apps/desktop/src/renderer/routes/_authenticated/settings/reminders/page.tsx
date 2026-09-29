import { createFileRoute } from "@tanstack/react-router";
import { BoardSettingsPage, NotifyAtRow } from "../board/rows";

export const Route = createFileRoute("/_authenticated/settings/reminders/")({
	component: RemindersSettingsPage,
});

function RemindersSettingsPage() {
	return (
		<BoardSettingsPage
			title="Reminders"
			description="When Remind me sessions and due dates notify"
		>
			<NotifyAtRow />
		</BoardSettingsPage>
	);
}
