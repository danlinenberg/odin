import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ClaudeCommandState {
	/** Your own ways to start Claude - an alias, a function, a full path. */
	commands: string[];
	/** The one new sessions use, while it's still in the list. */
	active: string;
	setCommands: (commands: string[]) => void;
	setActive: (command: string) => void;
}

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
			setCommands: (commands) => set({ commands }),
			setActive: (active) => set({ active }),
		}),
		{ name: "odin-claude-command" },
	),
);

/** The command to run Claude with: the picked one, else the first, else `claude`. */
export function pickClaudeCommand(commands: string[], active: string): string {
	return commands.includes(active) ? active : (commands[0] ?? "claude");
}

/** `claude --dangerously-skip-permissions`, through your chosen command. */
export function claudeCli(): string {
	const { commands, active } = useClaudeCommand.getState();
	return `${pickClaudeCommand(commands, active)} --dangerously-skip-permissions`;
}
