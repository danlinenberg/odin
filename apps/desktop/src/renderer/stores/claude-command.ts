import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ClaudeCommandState {
	/** Your own ways to start Claude - an alias, a function, a full path. */
	commands: string[];
	/** The one new sessions use, while it's still in the list. */
	active: string;
	/** `--model` for new sessions; "" leaves it to Claude's own default. */
	model: string;
	/** New Session: park the prompt on My Tasks instead of starting it. */
	toBacklog: boolean;
	/** New task: start a session on it right away instead of just listing it. */
	startNow: boolean;
	/** Start every session with Remote Control on, named after its task. */
	remoteControl: boolean;
	setCommands: (commands: string[]) => void;
	setActive: (command: string) => void;
	setModel: (model: string) => void;
	setToBacklog: (toBacklog: boolean) => void;
	setStartNow: (startNow: boolean) => void;
	setRemoteControl: (remoteControl: boolean) => void;
}

/** The New Session model picker: CLI aliases, so each tracks the latest. */
export const CLAUDE_MODELS = [
	{ value: "", label: "Default model" },
	{ value: "fable", label: "Fable" },
	{ value: "opus", label: "Opus" },
	{ value: "sonnet", label: "Sonnet" },
	{ value: "haiku", label: "Haiku" },
];

/**
 * Settings → Advanced: what Odin types instead of `claude` when it starts or
 * resumes a session. One machine can carry several Claude setups (a Bedrock
 * one, a personal account), and plain `claude` may resolve to the wrong one.
 *
 * ponytail: renderer localStorage, like launch-limits - every launch site is
 * in the renderer. The main process's own `claude -p` calls (briefs, sweeps)
 * still use plain `claude`.
 */
export const useClaudeCommand = create<ClaudeCommandState>()(
	persist(
		(set) => ({
			commands: [],
			active: "",
			model: "",
			toBacklog: false,
			startNow: false,
			remoteControl: false,
			setCommands: (commands) => set({ commands }),
			setActive: (active) => set({ active }),
			setModel: (model) => set({ model }),
			setToBacklog: (toBacklog) => set({ toBacklog }),
			setStartNow: (startNow) => set({ startNow }),
			setRemoteControl: (remoteControl) => set({ remoteControl }),
		}),
		{ name: "odin-claude-command" },
	),
);

/** The command to run Claude with: the picked one, else the first, else `claude`. */
export function pickClaudeCommand(commands: string[], active: string): string {
	return commands.includes(active) ? active : (commands[0] ?? "claude");
}

/** `claude --dangerously-skip-permissions [--model x]`, through your chosen command. */
function claudeCli(): string {
	const { commands, active, model } = useClaudeCommand.getState();
	return `${pickClaudeCommand(commands, active)} --dangerously-skip-permissions${modelFlag(model)}`;
}

/** Only a known alias reaches the shell - the stored value is user-editable. */
export function modelFlag(model: string): string {
	return model && CLAUDE_MODELS.some((m) => m.value === model)
		? ` --model ${model}`
		: "";
}

/**
 * ` --remote-control '<name>'` when Settings → Sessions has it on, so the
 * session shows up in claude.ai/code and the Claude app under its task's name.
 */
/**
 * Remote Control needs your claude.ai login. A `claude setup-token` token or an
 * API key in the environment (often exported from ~/.zshenv) wins over it, and
 * then Claude starts as "Claude API" with Remote Control silently off. Drop
 * both for this one session's shell.
 */
export function remoteControlEnv(
	on = useClaudeCommand.getState().remoteControl,
): string {
	return on ? "unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && " : "";
}

export function remoteControlFlag(
	name: string,
	on = useClaudeCommand.getState().remoteControl,
): string {
	if (!on) return "";
	// ponytail: 80 chars, the session list truncates long names anyway.
	const trimmed = name.replace(/\s+/g, " ").trim().slice(0, 80);
	return trimmed
		? ` --remote-control '${trimmed.replaceAll("'", `'\\''`)}'`
		: " --remote-control";
}

/**
 * The one way Odin starts Claude in a session - new, resume, retry, a resume
 * handed to VS Code. Each one built its own string, and Resume dropped
 * Remote Control. `name` is the task's title, `args` what follows the flags
 * (`--resume <id>`, `--session-id <id> '<prompt>'`).
 */
export function claudeLaunch(
	name: string,
	args: string,
	remoteControl = useClaudeCommand.getState().remoteControl,
): string {
	return `${remoteControlEnv(remoteControl)}${claudeCli()}${remoteControlFlag(name, remoteControl)} ${args}`;
}
