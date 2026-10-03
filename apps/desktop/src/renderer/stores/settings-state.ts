import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type SettingsSection =
	| "appearance"
	| "ringtones"
	| "keyboard"
	| "behavior"
	| "git"
	| "agents"
	| "terminal"
	| "links"
	| "models"
	| "experimental"
	| "connections"
	| "permissions"
	| "project";

interface SettingsState {
	activeSection: SettingsSection;
	activeProjectId: string | null;
	isOpen: boolean;
	originRoute: string;

	setActiveSection: (section: SettingsSection) => void;
	setActiveProject: (projectId: string | null) => void;
	openSettings: (section?: SettingsSection) => void;
	closeSettings: () => void;
	setOriginRoute: (route: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
	devtools(
		(set) => ({
			activeSection: "connections",
			activeProjectId: null,
			isOpen: false,
			originRoute: "/workspace",

			setActiveSection: (section) => set({ activeSection: section }),

			setActiveProject: (projectId) =>
				set({
					activeProjectId: projectId,
					activeSection: "project",
				}),

			openSettings: (section) =>
				set({
					isOpen: true,
					activeSection: section ?? "connections",
				}),

			closeSettings: () => set({ isOpen: false }),

			setOriginRoute: (route) => set({ originRoute: route }),
		}),
		{ name: "SettingsStore" },
	),
);

export const useSettingsSection = () =>
	useSettingsStore((state) => state.activeSection);
export const useSetSettingsSection = () =>
	useSettingsStore((state) => state.setActiveSection);
export const useActiveProjectId = () =>
	useSettingsStore((state) => state.activeProjectId);
export const useCloseSettings = () =>
	useSettingsStore((state) => state.closeSettings);
export const useSettingsOriginRoute = () =>
	useSettingsStore((state) => state.originRoute);
