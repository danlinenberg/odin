import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@odin/ui/select";
import { createFileRoute } from "@tanstack/react-router";
import {
	type RemoteControlMode,
	useClaudeCommand,
} from "renderer/stores/claude-command";
import {
	SettingRow,
	SettingsPage,
	SettingsSection,
} from "../components/SettingsPage";
import { PhoneSection } from "./components/PhoneSection";
import { RemoteHostSection } from "./components/RemoteHostSection";

export const Route = createFileRoute("/_authenticated/settings/remote/")({
	component: RemoteSettingsPage,
});

/**
 * Settings > Remote: everything about sessions when you're away from this
 * Mac - a host that runs them with the lid shut, the iPhone app that shows
 * the board, and the Claude app that follows a session.
 */
function RemoteSettingsPage() {
	return (
		<SettingsPage
			title="Remote"
			description="Your sessions when you're not at this Mac: run them on a host that stays up, see the board from your iPhone, follow them in the Claude app."
		>
			<RemoteHostSection />
			<PhoneSection />
			<SettingsSection
				title="Claude app"
				description="Sessions in claude.ai/code and the Claude app on your phone."
			>
				<RemoteControlRow />
			</SettingsSection>
		</SettingsPage>
	);
}

/** `claude --remote-control '[Odin] <task title>'` on launch and Resume. */
function RemoteControlRow() {
	const mode = useClaudeCommand((s) => s.remoteControl);
	const setRemoteControl = useClaudeCommand((s) => s.setRemoteControl);
	return (
		<SettingRow
			label="Remote Control"
			htmlFor="remote-control"
			description={
				mode === "all"
					? "Every session shows up in claude.ai/code and the Claude app as [Odin] <task>. That is a lot of sessions in your Claude app - pick Selected sessions to choose them one by one."
					: mode === "selected"
						? "Turn it on for one session from its right-click menu or the Remote Control button in its drawer. It shows up in claude.ai/code and the Claude app as [Odin] <task>."
						: "Follow and answer sessions from claude.ai/code or the Claude app on your phone. Uses your claude.ai login, not a setup-token or API key from your shell."
			}
		>
			<Select
				value={mode}
				onValueChange={(value) => setRemoteControl(value as RemoteControlMode)}
			>
				<SelectTrigger id="remote-control" className="w-[180px]">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="off">Off</SelectItem>
					<SelectItem value="all">Every session</SelectItem>
					<SelectItem value="selected">Selected sessions</SelectItem>
				</SelectContent>
			</Select>
		</SettingRow>
	);
}
