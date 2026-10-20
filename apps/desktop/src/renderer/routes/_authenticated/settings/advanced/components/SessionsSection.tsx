import { Button } from "@odin/ui/button";
import { Textarea } from "@odin/ui/textarea";
import { useState } from "react";
import { ClaudeCommandPicker } from "renderer/components/ClaudeCommandPicker";
import { DEFAULT_SESSION_INSTRUCTIONS } from "renderer/hooks/useLaunchTaskSession";
import { useClaudeCommand } from "renderer/stores/claude-command";
import { useSessionInstructions } from "renderer/stores/session-instructions";
import { SettingRow, SettingsSection } from "../../components/SettingsPage";

/** What starts Claude for a session, and the prompt every task ends with. */
export function SessionsSection() {
	return (
		<SettingsSection title="Sessions">
			<ClaudeCommandRow />
			<SessionInstructionsRow />
		</SettingsSection>
	);
}

/**
 * The standing instructions every task prompt ends with. Saved on blur; text
 * equal to the default is stored as "no override", so later default changes
 * still reach it.
 */
function SessionInstructionsRow() {
	const instructions = useSessionInstructions((s) => s.instructions);
	const setInstructions = useSessionInstructions((s) => s.setInstructions);
	const [draft, setDraft] = useState(
		instructions ?? DEFAULT_SESSION_INSTRUCTIONS,
	);
	const save = () =>
		setInstructions(draft === DEFAULT_SESSION_INSTRUCTIONS ? null : draft);
	const reset = () => {
		setInstructions(null);
		setDraft(DEFAULT_SESSION_INSTRUCTIONS);
	};
	return (
		<SettingRow
			label="Default prompt"
			htmlFor="session-instructions"
			description="Added to the end of every task a session starts with: how to work, where to run things, the ACTION ITEMS section. The board reads ACTION ITEMS from each reply, so keep that part if you want it there."
			stacked
		>
			<Textarea
				id="session-instructions"
				value={draft}
				rows={10}
				spellCheck={false}
				className="font-mono text-xs"
				onChange={(event) => setDraft(event.target.value)}
				onBlur={save}
			/>
			<div className="mt-2 flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8"
					disabled={
						instructions === null && draft === DEFAULT_SESSION_INSTRUCTIONS
					}
					onClick={reset}
				>
					Reset to default
				</Button>
				{instructions !== null && (
					<span className="text-xs text-muted-foreground">Edited</span>
				)}
			</div>
		</SettingRow>
	);
}

/**
 * What Odin runs instead of `claude` - an alias or function from your shell
 * rc works, the session shell sources it. One per line; two or more puts a
 * picker in the top bar.
 */
function ClaudeCommandRow() {
	const commands = useClaudeCommand((s) => s.commands);
	const setCommands = useClaudeCommand((s) => s.setCommands);
	const [draft, setDraft] = useState(commands.join("\n"));
	const save = () =>
		setCommands([
			...new Set(
				draft
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean),
			),
		]);
	return (
		<SettingRow
			label="Claude command"
			htmlFor="claude-command"
			description="What starts Claude in a new or resumed session, e.g. an alias for another account. One per line - with two or more, pick one in the top bar. Empty: claude."
			stacked
		>
			<Textarea
				id="claude-command"
				value={draft}
				placeholder="claude"
				rows={3}
				spellCheck={false}
				className="font-mono text-xs"
				onChange={(event) => setDraft(event.target.value)}
				onBlur={save}
			/>
			<ClaudeCommandPicker className="mt-2" />
		</SettingRow>
	);
}
