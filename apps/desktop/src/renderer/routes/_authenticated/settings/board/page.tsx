import { createFileRoute } from "@tanstack/react-router";
import { AutoRenameRow, BoardSettingsPage, IdleCloseRow } from "../board/rows";

export const Route = createFileRoute("/_authenticated/settings/board/")({
	component: CardsSettingsPage,
});

function CardsSettingsPage() {
	return (
		<BoardSettingsPage
			title="Cards"
			description="How the board names your sessions, and when it closes idle ones"
		>
			<AutoRenameRow />
			<IdleCloseRow />
		</BoardSettingsPage>
	);
}
