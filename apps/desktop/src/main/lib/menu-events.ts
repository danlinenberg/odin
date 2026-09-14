import { EventEmitter } from "node:events";
export type SettingsSection =
	| "project"
	| "appearance"
	| "keyboard"
	| "behavior"
	| "git"
	| "terminal";

export interface OpenSettingsEvent {
	section?: SettingsSection;
}

export interface OpenWorkspaceEvent {
	workspaceId: string;
}

export const menuEmitter = new EventEmitter();
