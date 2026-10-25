import { Button } from "@odin/ui/button";
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

/**
 * Settings > Advanced: what a session runs - the command that starts Claude
 * and the prompt every task ends with. Rarely changed, and long, so they sit
 * apart from the everyday Sessions settings.
 */
function AdvancedSettingsPage() {
	return (
		<SettingsPage
			title="Advanced"
			description="What a session runs: the command that starts Claude, and the instructions every task ends with."
		>
			<SettingsSection
				title="What they run"
				description="The command that starts Claude, and the instructions every task ends with."
			>
				<ClaudeCommandRow />
				<SessionInstructionsRow />
			</SettingsSection>
			<SettingsSection
				title="Plugins"
				description="The Claude Code plugins your sessions load their skills from."
			>
				<UpdatePluginsRow />
			</SettingsSection>
		</SettingsPage>
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
 * Pulls the newest version of every enabled plugin, so everyone on a team
 * runs the same skills. Sessions already open keep the old version until
 * they restart, as with Claude Code's own /plugin.
 */
function UpdatePluginsRow() {
	const utils = electronTrpc.useUtils();
	const update = electronTrpc.skills.updatePlugins.useMutation({
		onSuccess: () => utils.skills.list.invalidate(),
	});
	const result = update.data;
	const changed = result?.plugins.filter((plugin) => plugin.to !== plugin.from);
	const failed = result?.plugins.filter((plugin) => plugin.error);
	return (
		<SettingRow
			label="Update plugins"
			description="Refresh every marketplace and move each enabled plugin to its newest version. New sessions use the new versions; open ones keep theirs until they restart."
			stacked
		>
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8"
					disabled={update.isPending}
					onClick={() => update.mutate()}
				>
					{update.isPending ? "Updating..." : "Update plugins"}
				</Button>
				{result && changed && (
					<span className="text-xs text-muted-foreground">
						{changed.length
							? `${changed.length} of ${result.plugins.length} updated`
							: `All ${result.plugins.length} up to date`}
					</span>
				)}
			</div>
			{update.error && (
				<p className="select-text cursor-text text-xs text-destructive">
					{update.error.message}
				</p>
			)}
			{result && (
				<ul className="select-text cursor-text space-y-0.5 font-mono text-xs">
					{result.marketplaceError && (
						<li className="text-destructive">
							Marketplaces not refreshed: {result.marketplaceError}
						</li>
					)}
					{changed?.map((plugin) => (
						<li key={plugin.id}>
							{plugin.id} {plugin.from} -&gt; {plugin.to}
						</li>
					))}
					{failed?.map((plugin) => (
						<li key={plugin.id} className="text-destructive">
							{plugin.id}: {plugin.error}
						</li>
					))}
				</ul>
			)}
		</SettingRow>
	);
}
