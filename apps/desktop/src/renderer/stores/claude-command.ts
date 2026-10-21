import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ClaudeCommandState {
	/** Your own ways to start Claude - an alias, a function, a full path. */
	commands: string[];
	/** The one new sessions use, while it's still in the list. */
	active: string;
	/** `--model` for new sessions; "" leaves it to Claude's own default. */
	model: string;
	/** `--model` for the raven: Haiku unless his panel's picker says otherwise. */
	crowModel: string;
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
	setCrowModel: (model: string) => void;
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

/** What the raven runs on out of the box: quick and cheap, the alias always the latest Haiku. */
export const CROW_DEFAULT_MODEL = "haiku";

/**
 * Settings → Sessions: what Odin types instead of `claude` when it starts or
 * resumes a session. One machine can carry several Claude setups (a Bedrock
 * one, a personal account), and plain `claude` may resolve to the wrong one.
 */
export const useClaudeCommand = create<ClaudeCommandState>()(
	persist(
		(set) => ({
			commands: [],
			active: "",
			model: "",
			crowModel: CROW_DEFAULT_MODEL,
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
			setCrowModel: (crowModel) => set({ crowModel }),
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

/**
 * A command in Settings > Advanced can be a shell wrapper - `zsh -ic 'claude'`,
 * so your rc file sets Claude up first. The flags used to go after the closing
 * quote, where `-c` makes them the shell's own `$0 $1 ...`: claude started
 * bare, with no --session-id and no prompt, and the task's first message was
 * never sent. Hand them through the wrapper as its positional parameters -
 * `zsh -ic 'claude "$@"' zsh <flags>` - with `env` (Remote Control's unset)
 * inside too, since the wrapper's rc file would export the token right back.
 * A plain command stays `claude <flags>`.
 */
const SHELL_WRAPPER =
	/^((?:\S*\/)?(?:sh|bash|zsh|ksh|dash))((?:\s+--?[\w-]+)*\s+-\w*c)\s+(?:(['"])(.+)\3|([^'"\s]+))\s*$/;

export function claudeWithFlags(
	command: string,
	flags: string,
	env = "",
): string {
	const wrapper = command.match(SHELL_WRAPPER);
	if (!wrapper) return `${env}${command} ${flags}`;
	const [, shell, options, quoteMark, quoted, bare] = wrapper;
	const quote = quoteMark ?? "'";
	// Inside double quotes the outer shell would read "$@" itself.
	const args = quote === '"' ? '\\"\\$@\\"' : '"$@"';
	return `${shell}${options} ${quote}${env}${quoted ?? bare} ${args}${quote} ${shell} ${flags}`;
}

/** Only a known alias reaches the shell - the stored value is user-editable. */
export function modelFlag(model: string): string {
	return model && CLAUDE_MODELS.some((m) => m.value === model)
		? ` --model ${model}`
		: "";
}

/** The raven's ` --model x`: his pick, else Haiku - he always runs on a named one. */
export function crowModelFlag(model: string): string {
	return modelFlag(model) || modelFlag(CROW_DEFAULT_MODEL);
}

/** Whether this pane's session runs with Remote Control, per Settings → Remote. */
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
	const { commands, active, model } = useClaudeCommand.getState();
	const remoteControl = remoteControlOn(paneId);
	// "selected" drops the token on every launch: a session you switch on
	// later, mid-run, can only connect if it started on the claude.ai login.
	const login = useClaudeCommand.getState().remoteControl !== "off";
	return claudeWithFlags(
		pickClaudeCommand(commands, active),
		`--dangerously-skip-permissions${modelFlag(model)}${remoteControlFlag(name, remoteControl)} ${args}`,
		remoteControlEnv(login),
	);
}
