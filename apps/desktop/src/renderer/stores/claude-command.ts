import {
	claudeLaunchWith,
	type RemoteControlMode,
	remoteControlOnWith,
} from "shared/claude-launch";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export {
	CLAUDE_MODELS,
	modelFlag,
	pickClaudeCommand,
	type RemoteControlMode,
	remoteControlEnv,
	remoteControlFlag,
	remoteControlName,
} from "shared/claude-launch";

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

export const RECENT_REPOS = 5;

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

/** Whether this pane's session runs with Remote Control, per Settings → Sessions. */
export function remoteControlOn(paneId?: string): boolean {
	return remoteControlOnWith(useClaudeCommand.getState(), paneId);
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
	return claudeLaunchWith(useClaudeCommand.getState(), name, args, paneId);
}
