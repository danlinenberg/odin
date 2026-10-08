import { observable } from "@trpc/server/observable";
import { app } from "electron";
import { setGlobalNewTaskChord } from "main/lib/global-new-task";
import {
	menuEmitter,
	type OpenSettingsEvent,
	type OpenWorkspaceEvent,
	type SettingsSection,
} from "main/lib/menu-events";
import { z } from "zod";
import { publicProcedure, router } from "..";

type MenuEvent =
	| { type: "open-settings"; data: OpenSettingsEvent }
	| { type: "open-workspace"; data: OpenWorkspaceEvent }
	| { type: "open-project" }
	| { type: "toggle-presets-bar" }
	| { type: "new-task"; data: { fromElsewhere: boolean } };

export const createMenuRouter = () => {
	return router({
		subscribe: publicProcedure.subscription(() => {
			return observable<MenuEvent>((emit) => {
				const onOpenSettings = (section?: SettingsSection) => {
					emit.next({ type: "open-settings", data: { section } });
				};

				const onOpenWorkspace = (workspaceId: string) => {
					emit.next({ type: "open-workspace", data: { workspaceId } });
				};

				const onOpenProject = () => {
					emit.next({ type: "open-project" });
				};

				const onTogglePresetsBar = () => {
					emit.next({ type: "toggle-presets-bar" });
				};

				const onNewTask = (fromElsewhere: boolean) => {
					emit.next({ type: "new-task", data: { fromElsewhere } });
				};

				menuEmitter.on("open-settings", onOpenSettings);
				menuEmitter.on("open-workspace", onOpenWorkspace);
				menuEmitter.on("open-project", onOpenProject);
				menuEmitter.on("toggle-presets-bar", onTogglePresetsBar);
				menuEmitter.on("new-task", onNewTask);

				return () => {
					menuEmitter.off("open-settings", onOpenSettings);
					menuEmitter.off("open-workspace", onOpenWorkspace);
					menuEmitter.off("open-project", onOpenProject);
					menuEmitter.off("toggle-presets-bar", onTogglePresetsBar);
					menuEmitter.off("new-task", onNewTask);
				};
			});
		}),
		/** The New Task chord, registered system-wide; null turns that off. */
		setNewTaskChord: publicProcedure
			.input(z.object({ chord: z.string().nullable() }))
			.mutation(({ input }) => setGlobalNewTaskChord(input.chord)),
		/** Back to whichever app was in front before the New Task chord. */
		hideApp: publicProcedure.mutation(() => {
			if (process.platform === "darwin") app.hide();
		}),
	});
};
