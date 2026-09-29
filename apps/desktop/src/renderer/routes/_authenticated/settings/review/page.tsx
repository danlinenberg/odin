import { createFileRoute } from "@tanstack/react-router";
import { BoardSettingsPage, SweepIntervalRow } from "../board/rows";

export const Route = createFileRoute("/_authenticated/settings/review/")({
	component: ReviewSettingsPage,
});

function ReviewSettingsPage() {
	return (
		<BoardSettingsPage
			title="Review"
			description="The backlog sweep that fills Review"
		>
			<SweepIntervalRow />
		</BoardSettingsPage>
	);
}
