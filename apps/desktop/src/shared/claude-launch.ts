/**
 * How Odin starts Claude in a session, from Settings → Advanced and Sessions.
 * Shared so the window (renderer/stores/claude-command) and a remote server's
 * schedulers (main/odin-core) build the same command from the same settings.
 */

export type RemoteControlMode = "off" | "all" | "selected";

/** The settings a launch command is built from (the claude-command store's data). */
export interface ClaudeCommandSettings {
	/** Your own ways to start Claude - an alias, a function, a full path. */
	commands: string[];
	/** The one new sessions use, while it's still in the list. */
	active: string;
	/** `--model` for new sessions; "" leaves it to Claude's own default. */
	model: string;
	/** Remote Control: on for no session, every session, or the ones you pick. */
	remoteControl: RemoteControlMode;
	/** "selected": the panes you turned it on for, newest last. */
	remotePanes: string[];
}

export const DEFAULT_CLAUDE_COMMAND: ClaudeCommandSettings = {
	commands: [],
	active: "",
	model: "",
	remoteControl: "off",
	remotePanes: [],
};

/** The New Session model picker: CLI aliases, so each tracks the latest. */
export const CLAUDE_MODELS = [
	{ value: "", label: "Default model" },
	{ value: "fable", label: "Fable" },
	{ value: "opus", label: "Opus" },
	{ value: "sonnet", label: "Sonnet" },
	{ value: "haiku", label: "Haiku" },
];

/** The command to run Claude with: the picked one, else the first, else `claude`. */
export function pickClaudeCommand(commands: string[], active: string): string {
	return commands.includes(active) ? active : (commands[0] ?? "claude");
}

/** Only a known alias reaches the shell - the stored value is user-editable. */
export function modelFlag(model: string): string {
	return model && CLAUDE_MODELS.some((m) => m.value === model)
		? ` --model ${model}`
		: "";
}

/** Whether this pane's session runs with Remote Control, per Settings → Sessions. */
export function remoteControlOnWith(
	settings: Pick<ClaudeCommandSettings, "remoteControl" | "remotePanes">,
	paneId?: string,
): boolean {
	return (
		settings.remoteControl === "all" ||
		(settings.remoteControl === "selected" &&
			!!paneId &&
			settings.remotePanes.includes(paneId))
	);
}

/** The session's name on claude.ai: always `[Odin] <task>`, so they stand out there. */
export function remoteControlName(name: string): string {
	// ponytail: 80 chars, the session list truncates long names anyway.
	return `[Odin] ${name.replace(/\s+/g, " ").trim()}`.trim().slice(0, 80);
}

/**
 * Remote Control needs your claude.ai login. A `claude setup-token` token or an
 * API key in the environment (often exported from ~/.zshenv) wins over it, and
 * then Claude starts as "Claude API" with Remote Control silently off. Drop
 * both for this one session's shell.
 */
export function remoteControlEnv(on: boolean): string {
	return on ? "unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && " : "";
}

/**
 * ` --remote-control '[Odin] <name>'` when it's on for this session, so it
 * shows up in claude.ai/code and the Claude app under its task's name.
 */
export function remoteControlFlag(name: string, on: boolean): string {
	if (!on) return "";
	return ` --remote-control '${remoteControlName(name).replaceAll("'", `'\\''`)}'`;
}

/**
 * The one way Odin starts Claude in a session - new, resume, retry, a resume
 * handed to VS Code. `name` is the task's title, `args` what follows the flags
 * (`--resume <id>`, `--session-id <id> '<prompt>'`), `paneId` the session's
 * pane once it has one - it decides Remote Control under "selected".
 */
export function claudeLaunchWith(
	settings: ClaudeCommandSettings,
	name: string,
	args: string,
	paneId?: string,
): string {
	const remoteControl = remoteControlOnWith(settings, paneId);
	// "selected" drops the token on every launch: a session you switch on
	// later, mid-run, can only connect if it started on the claude.ai login.
	const login = settings.remoteControl !== "off";
	const cli = `${pickClaudeCommand(settings.commands, settings.active)} --dangerously-skip-permissions${modelFlag(settings.model)}`;
	return `${remoteControlEnv(login)}${cli}${remoteControlFlag(name, remoteControl)} ${args}`;
}
