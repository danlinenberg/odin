import type { BrowserWindow } from "electron";
import { router } from "..";
import { createAnalyticsRouter } from "./analytics";
import { createAutoUpdateRouter } from "./auto-update";
import { createBacklogReviewRouter } from "./backlog-review";
import { createBrowserRouter } from "./browser/browser";
import { createBrowserHistoryRouter } from "./browser-history";
import { createChangesRouter } from "./changes";
import { createConfigRouter } from "./config";
import { createConnectionsRouter } from "./connections";
import { createDeviceRouter } from "./device";
import { createExternalRouter } from "./external";
import { createFilesystemRouter } from "./filesystem";
import { createHostServiceCoordinatorRouter } from "./host-service-coordinator";
import { createInsightsRouter } from "./insights";
import { createKeyboardLayoutRouter } from "./keyboardLayout";
import { createMenuRouter } from "./menu";
import { createMigrationRouter } from "./migration";
import { createNotificationsRouter } from "./notifications";
import { createNotionRouter } from "./notion";
import { createPermissionsRouter } from "./permissions";
import { createPortsRouter } from "./ports";
import { createProjectsRouter } from "./projects";
import { createReposRouter } from "./repos";
import { createResourceMetricsRouter } from "./resource-metrics";
import { createSettingsRouter } from "./settings";
import { createSkillsRouter } from "./skills";
import { createSlackRouter } from "./slack";
import { createSystemRouter } from "./system";
import { createTerminalRouter } from "./terminal";
import { createUiStateRouter } from "./ui-state";
import { createWindowRouter } from "./window";
import { createWorkRouter } from "./work";
import { createWorkLogRouter } from "./work-log";
import { createWorkspacesRouter } from "./workspaces";

export const createAppRouter = (getWindow: () => BrowserWindow | null) => {
	return router({
		analytics: createAnalyticsRouter(),
		browser: createBrowserRouter(),
		browserHistory: createBrowserHistoryRouter(),
		autoUpdate: createAutoUpdateRouter(),
		window: createWindowRouter(getWindow),
		projects: createProjectsRouter(getWindow),
		repos: createReposRouter(),
		workspaces: createWorkspacesRouter(),
		terminal: createTerminalRouter(),
		changes: createChangesRouter(),
		filesystem: createFilesystemRouter(),
		notifications: createNotificationsRouter(getWindow),
		notion: createNotionRouter(),
		slack: createSlackRouter(),
		backlogReview: createBacklogReviewRouter(),
		connections: createConnectionsRouter(),
		work: createWorkRouter(),
		insights: createInsightsRouter(),
		workLog: createWorkLogRouter(),
		permissions: createPermissionsRouter(),
		ports: createPortsRouter(),
		resourceMetrics: createResourceMetricsRouter(),
		keyboardLayout: createKeyboardLayoutRouter(),
		menu: createMenuRouter(),
		external: createExternalRouter(),
		settings: createSettingsRouter(),
		skills: createSkillsRouter(),
		system: createSystemRouter(),
		config: createConfigRouter(),
		device: createDeviceRouter(),
		uiState: createUiStateRouter(),
		hostServiceCoordinator: createHostServiceCoordinatorRouter(),
		migration: createMigrationRouter(),
	});
};

export type AppRouter = ReturnType<typeof createAppRouter>;
