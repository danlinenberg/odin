import { createFileRoute } from "@tanstack/react-router";
import { AutoRenameRow, BoardSettingsPage } from "../board/rows";

export const Route = createFileRoute("/_authenticated/settings/board/")({
	component: CardsSettingsPage,
});

function CardsSettingsPage() {
	return (
		<BoardSettingsPage
			title="Cards"
			description="How the board names your sessions"
		>
			<AutoRenameRow />
		</BoardSettingsPage>
	);
}
