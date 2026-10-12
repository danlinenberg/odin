import { Button } from "@odin/ui/button";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { Textarea } from "@odin/ui/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ClaudeCommandPicker } from "renderer/components/ClaudeCommandPicker";
import { DEFAULT_SESSION_INSTRUCTIONS } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useClaudeCommand } from "renderer/stores/claude-command";
import { useSessionInstructions } from "renderer/stores/session-instructions";
import {
	SettingRow,
	SettingsPage,
	SettingsSection,
} from "../components/SettingsPage";

export const Route = createFileRoute("/_authenticated/settings/advanced/")({
	component: AdvancedSettingsPage,
});

function AdvancedSettingsPage() {
	return (
		<SettingsPage
			title="Advanced"
			description="Settings most people never need to change."
		>
			<SettingsSection title="Sessions">
				<ClaudeCommandRow />
				<SessionInstructionsRow />
			</SettingsSection>

			<SettingsSection title="Cleanup">
				<PruneMergedRow />
			</SettingsSection>
		</SettingsPage>
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

/** Remove a session's worktree once its PR merges - main's pruner reads it. */
function PruneMergedRow() {
	const utils = electronTrpc.useUtils();
	const { data: enabled, isLoading } =
		electronTrpc.repos.getPruneMerged.useQuery();
	const setEnabled = electronTrpc.repos.setPruneMerged.useMutation({
		onSuccess: () => void utils.repos.getPruneMerged.invalidate(),
		onError: (error) => toast.error(error.message),
	});
	return (
		<SettingRow
			label="Delete worktrees when their PR merges"
			htmlFor="prune-merged-worktrees"
			description="Checked every 10 minutes in every repo with a .worktrees folder. A worktree with uncommitted files waits 7 days, then its files are saved to refs/pruned/<name> first. Off keeps every worktree."
		>
			<Switch
				id="prune-merged-worktrees"
				checked={enabled ?? true}
				onCheckedChange={(on) => setEnabled.mutate({ enabled: on })}
				disabled={isLoading || setEnabled.isPending}
			/>
		</SettingRow>
	);
}
