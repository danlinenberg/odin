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
	/** Remote Control: on for no session, every session, or the ones you pick. */
	remoteControl: RemoteControlMode;
	/** "selected": the panes you turned it on for, newest last. */
	remotePanes: string[];
	/** New Session's one-click repos: the last ones started in, newest first. */
	recentRepos: string[];
	addRecentRepo: (repo: string) => void;
	setCommands: (commands: string[]) => void;
	setActive: (command: string) => void;
	setModel: (model: string) => void;
	setToBacklog: (toBacklog: boolean) => void;
	setStartNow: (startNow: boolean) => void;
	setRemoteControl: (remoteControl: RemoteControlMode) => void;
	toggleRemotePane: (paneId: string) => void;
}

export type RemoteControlMode = "off" | "all" | "selected";

export const RECENT_REPOS = 5;

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
 */
export const useClaudeCommand = create<ClaudeCommandState>()(
	persist(
		(set) => ({
			commands: [],
			active: "",
			model: "",
			toBacklog: false,
			startNow: false,
			remoteControl: "off",
			remotePanes: [],
			recentRepos: [],
			addRecentRepo: (repo) =>
				set((s) => ({
					recentRepos: [repo, ...s.recentRepos.filter((r) => r !== repo)].slice(
						0,
						RECENT_REPOS,
					),
				})),
			setCommands: (commands) => set({ commands }),
			setActive: (active) => set({ active }),
			setModel: (model) => set({ model }),
			setToBacklog: (toBacklog) => set({ toBacklog }),
			setStartNow: (startNow) => set({ startNow }),
			setRemoteControl: (remoteControl) => set({ remoteControl }),
			toggleRemotePane: (paneId) =>
				set((s) => ({
					remotePanes: s.remotePanes.includes(paneId)
						? s.remotePanes.filter((id) => id !== paneId)
						: [...s.remotePanes, paneId].slice(-100),
				})),
		}),
		{
			name: "odin-claude-command",
			version: 1,
			// v0 stored Remote Control as a boolean: true meant every session.
			migrate: (state, version) => {
				const s = state as Omit<ClaudeCommandState, "remoteControl"> & {
					remoteControl: unknown;
				};
				if (version < 1)
					s.remoteControl = s.remoteControl === true ? "all" : "off";
				return s;
			},
		},
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

/** Whether this pane's session runs with Remote Control, per Settings → Sessions. */
export function remoteControlOn(paneId?: string): boolean {
	const { remoteControl, remotePanes } = useClaudeCommand.getState();
	return (
		remoteControl === "all" ||
		(remoteControl === "selected" && !!paneId && remotePanes.includes(paneId))
	);
}

/** The session's name on claude.ai: always `[Odin] <task>`, so they stand out there. */
export function remoteControlName(name: string): string {
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
 * handed to VS Code. Each one built its own string, and Resume dropped
 * Remote Control. `name` is the task's title, `args` what follows the flags
 * (`--resume <id>`, `--session-id <id> '<prompt>'`), `paneId` the session's
 * pane once it has one - it decides Remote Control under "selected".
 */
export function claudeLaunch(
	name: string,
	args: string,
	paneId?: string,
): string {
	const remoteControl = remoteControlOn(paneId);
	// "selected" drops the token on every launch: a session you switch on
	// later, mid-run, can only connect if it started on the claude.ai login.
	const login = useClaudeCommand.getState().remoteControl !== "off";
	return `${remoteControlEnv(login)}${claudeCli()}${remoteControlFlag(name, remoteControl)} ${args}`;
}
