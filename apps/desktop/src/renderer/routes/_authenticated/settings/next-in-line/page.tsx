import { createFileRoute } from "@tanstack/react-router";
import {
	BoardSettingsPage,
	NextInLinePromptRow,
	OffHoursRows,
	PinOverdueDaysRow,
} from "../board/rows";

export const Route = createFileRoute("/_authenticated/settings/next-in-line/")({
	component: NextInLineSettingsPage,
});

function NextInLineSettingsPage() {
	return (
		<BoardSettingsPage
			title="Next in line"
			description="How the board orders tasks nobody has started yet, and working them overnight"
		>
			<NextInLinePromptRow />
			<PinOverdueDaysRow />
			<OffHoursRows />
		</BoardSettingsPage>
	);
}
