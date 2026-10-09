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
	setCommands: (commands: string[]) => void;
	setActive: (command: string) => void;
	setModel: (model: string) => void;
	setToBacklog: (toBacklog: boolean) => void;
	setStartNow: (startNow: boolean) => void;
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
 * Settings → Sessions: what Odin types instead of `claude` when it starts or
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
			setCommands: (commands) => set({ commands }),
			setActive: (active) => set({ active }),
			setModel: (model) => set({ model }),
			setToBacklog: (toBacklog) => set({ toBacklog }),
			setStartNow: (startNow) => set({ startNow }),
		}),
		{ name: "odin-claude-command" },
	),
);

/** The command to run Claude with: the picked one, else the first, else `claude`. */
export function pickClaudeCommand(commands: string[], active: string): string {
	return commands.includes(active) ? active : (commands[0] ?? "claude");
}

/** `claude --dangerously-skip-permissions [--model x]`, through your chosen command. */
export function claudeCli(): string {
	const { commands, active, model } = useClaudeCommand.getState();
	return `${pickClaudeCommand(commands, active)} --dangerously-skip-permissions${modelFlag(model)}`;
}

/** Only a known alias reaches the shell - the stored value is user-editable. */
export function modelFlag(model: string): string {
	return model && CLAUDE_MODELS.some((m) => m.value === model)
		? ` --model ${model}`
		: "";
}
