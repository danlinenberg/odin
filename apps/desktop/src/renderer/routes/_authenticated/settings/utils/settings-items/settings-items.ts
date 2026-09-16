import type { SettingsSection } from "renderer/stores/settings-state";

export const SETTING_ITEM_ID = {
	APPEARANCE_THEME: "appearance-theme",
	APPEARANCE_MARKDOWN: "appearance-markdown",
	APPEARANCE_CUSTOM_THEMES: "appearance-custom-themes",
	APPEARANCE_EDITOR_FONT: "appearance-editor-font",
	APPEARANCE_TERMINAL_FONT: "appearance-terminal-font",

	RINGTONES_NOTIFICATION: "ringtones-notification",

	KEYBOARD_SHORTCUTS: "keyboard-shortcuts",

	CONNECTIONS_SLACK: "connections-slack",
	CONNECTIONS_GITHUB: "connections-github",
	CONNECTIONS_JIRA: "connections-jira",
	CONNECTIONS_NOTION: "connections-notion",

	BEHAVIOR_CONFIRM_QUIT: "behavior-confirm-quit",
	BEHAVIOR_FILE_OPEN_MODE: "behavior-file-open-mode",
	BEHAVIOR_RESOURCE_MONITOR: "behavior-resource-monitor",
	BEHAVIOR_OPEN_LINKS_IN_APP: "behavior-open-links-in-app",
	BEHAVIOR_AUTO_RENAME_SESSIONS: "behavior-auto-rename-sessions",

	GIT_BRANCH_PREFIX: "git-branch-prefix",
	GIT_DELETE_LOCAL_BRANCH: "git-delete-local-branch",
	GIT_WORKTREE_LOCATION: "git-worktree-location",

	AGENTS_ENABLED: "agents-enabled",
	AGENTS_COMMANDS: "agents-commands",
	AGENTS_TASK_PROMPTS: "agents-task-prompts",

	TERMINAL_PRESETS: "terminal-presets",
	TERMINAL_QUICK_ADD: "terminal-quick-add",
	TERMINAL_SESSIONS: "terminal-sessions",
	TERMINAL_LINK_BEHAVIOR: "terminal-link-behavior",
	TERMINAL_BACKGROUND_LIMIT: "terminal-background-limit",

	LINKS_FILE: "links-file",
	LINKS_URL: "links-url",
	LINKS_SIDEBAR_FILE: "links-sidebar-file",
	LINKS_PORT: "links-port",

	MODELS_ANTHROPIC: "models-anthropic",
	MODELS_OPENAI: "models-openai",

	EXPERIMENTAL_ODIN_V2: "experimental-odin-v2",
	EXPERIMENTAL_V1_MIGRATION: "experimental-v1-migration",
	EXPERIMENTAL_INLINE_WORKSPACE_PORTS: "experimental-inline-workspace-ports",
	EXPERIMENTAL_WORKSPACE_AGENTS: "experimental-workspace-agents",
	EXPERIMENTAL_WAIT_FOR_SETUP_BEFORE_AGENT:
		"experimental-wait-for-setup-before-agent",

	PROJECT_NAME: "project-name",
	PROJECT_PATH: "project-path",
	PROJECT_SCRIPTS: "project-scripts",
	PROJECT_BRANCH_PREFIX: "project-branch-prefix",
	PROJECT_WORKTREE_LOCATION: "project-worktree-location",
	PROJECT_IMPORT_WORKTREES: "project-import-worktrees",
	PROJECT_ENV_VARS: "project-env-vars",

	PERMISSIONS_FULL_DISK_ACCESS: "permissions-full-disk-access",
	PERMISSIONS_ACCESSIBILITY: "permissions-accessibility",
	PERMISSIONS_APPLE_EVENTS: "permissions-apple-events",
} as const;

export type SettingItemId =
	(typeof SETTING_ITEM_ID)[keyof typeof SETTING_ITEM_ID];

export interface SettingsItem {
	id: SettingItemId;
	section: SettingsSection;
}

/**
 * Which v1/v2 variant of the desktop UI a setting applies to.
 * - "v1": only used by the legacy desktop UI; hide when the user is on v2.
 * - "v2": only meaningful in the v2 desktop UI; hide when the user is on v1.
 * - "shared": applies to both (or is provided by a global/cloud surface).
 *
 * Source of truth for the v1/v2 settings audit. When adding a new setting,
 * pick a variant or it will fail typecheck on the registry below.
 */
export type SettingVariant = "v1" | "v2" | "shared";

export const SETTING_ITEM_VARIANT: Record<SettingItemId, SettingVariant> = {
	[SETTING_ITEM_ID.APPEARANCE_THEME]: "shared",
	[SETTING_ITEM_ID.APPEARANCE_MARKDOWN]: "shared",
	[SETTING_ITEM_ID.APPEARANCE_CUSTOM_THEMES]: "shared",
	[SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT]: "v2",
	[SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT]: "v2",

	[SETTING_ITEM_ID.RINGTONES_NOTIFICATION]: "shared",

	[SETTING_ITEM_ID.KEYBOARD_SHORTCUTS]: "shared",

	[SETTING_ITEM_ID.CONNECTIONS_SLACK]: "shared",
	[SETTING_ITEM_ID.CONNECTIONS_GITHUB]: "shared",
	[SETTING_ITEM_ID.CONNECTIONS_JIRA]: "shared",
	[SETTING_ITEM_ID.CONNECTIONS_NOTION]: "shared",

	[SETTING_ITEM_ID.BEHAVIOR_CONFIRM_QUIT]: "shared",
	[SETTING_ITEM_ID.BEHAVIOR_FILE_OPEN_MODE]: "v1",
	[SETTING_ITEM_ID.BEHAVIOR_RESOURCE_MONITOR]: "shared",
	[SETTING_ITEM_ID.BEHAVIOR_OPEN_LINKS_IN_APP]: "v1",
	[SETTING_ITEM_ID.BEHAVIOR_AUTO_RENAME_SESSIONS]: "shared",

	// Branch prefix exists in both UIs — v1 `GitSettings`, v2 `V2GitSettings`.
	[SETTING_ITEM_ID.GIT_BRANCH_PREFIX]: "shared",
	[SETTING_ITEM_ID.GIT_DELETE_LOCAL_BRANCH]: "v1",
	[SETTING_ITEM_ID.GIT_WORKTREE_LOCATION]: "shared",

	[SETTING_ITEM_ID.AGENTS_ENABLED]: "shared",
	[SETTING_ITEM_ID.AGENTS_COMMANDS]: "shared",
	[SETTING_ITEM_ID.AGENTS_TASK_PROMPTS]: "shared",

	[SETTING_ITEM_ID.TERMINAL_PRESETS]: "shared",
	[SETTING_ITEM_ID.TERMINAL_QUICK_ADD]: "shared",
	[SETTING_ITEM_ID.TERMINAL_SESSIONS]: "shared",
	[SETTING_ITEM_ID.TERMINAL_LINK_BEHAVIOR]: "v1",
	[SETTING_ITEM_ID.TERMINAL_BACKGROUND_LIMIT]: "v2",

	[SETTING_ITEM_ID.LINKS_FILE]: "v2",
	[SETTING_ITEM_ID.LINKS_URL]: "v2",
	[SETTING_ITEM_ID.LINKS_SIDEBAR_FILE]: "v2",
	[SETTING_ITEM_ID.LINKS_PORT]: "v2",

	[SETTING_ITEM_ID.MODELS_ANTHROPIC]: "shared",
	[SETTING_ITEM_ID.MODELS_OPENAI]: "shared",

	[SETTING_ITEM_ID.EXPERIMENTAL_ODIN_V2]: "shared",
	[SETTING_ITEM_ID.EXPERIMENTAL_V1_MIGRATION]: "v2",
	[SETTING_ITEM_ID.EXPERIMENTAL_INLINE_WORKSPACE_PORTS]: "v2",
	[SETTING_ITEM_ID.EXPERIMENTAL_WORKSPACE_AGENTS]: "v2",
	// Gates both the v1 renderer launch and the v2 host-side launch.
	[SETTING_ITEM_ID.EXPERIMENTAL_WAIT_FOR_SETUP_BEFORE_AGENT]: "shared",

	[SETTING_ITEM_ID.PROJECT_NAME]: "shared",
	[SETTING_ITEM_ID.PROJECT_PATH]: "shared",
	[SETTING_ITEM_ID.PROJECT_SCRIPTS]: "shared",
	[SETTING_ITEM_ID.PROJECT_BRANCH_PREFIX]: "v1",
	[SETTING_ITEM_ID.PROJECT_WORKTREE_LOCATION]: "shared",
	[SETTING_ITEM_ID.PROJECT_IMPORT_WORKTREES]: "v1",
	[SETTING_ITEM_ID.PROJECT_ENV_VARS]: "v2",

	[SETTING_ITEM_ID.PERMISSIONS_FULL_DISK_ACCESS]: "shared",
	[SETTING_ITEM_ID.PERMISSIONS_ACCESSIBILITY]: "shared",
	[SETTING_ITEM_ID.PERMISSIONS_APPLE_EVENTS]: "shared",
};

export function isItemAllowedForVariant(
	itemId: SettingItemId,
	isV2: boolean,
): boolean {
	const section = SECTION_BY_ITEM_ID.get(itemId);
	if (!section || !VISIBLE_SECTIONS.has(section)) return false;
	const variant = SETTING_ITEM_VARIANT[itemId];
	if (variant === "shared") return true;
	return isV2 ? variant === "v2" : variant === "v1";
}

export const SETTINGS_ITEMS: SettingsItem[] = [
	{ id: SETTING_ITEM_ID.APPEARANCE_THEME, section: "appearance" },
	{ id: SETTING_ITEM_ID.APPEARANCE_MARKDOWN, section: "appearance" },
	{ id: SETTING_ITEM_ID.APPEARANCE_CUSTOM_THEMES, section: "appearance" },
	{ id: SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT, section: "appearance" },
	{ id: SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT, section: "appearance" },

	{ id: SETTING_ITEM_ID.RINGTONES_NOTIFICATION, section: "ringtones" },

	{ id: SETTING_ITEM_ID.KEYBOARD_SHORTCUTS, section: "keyboard" },

	{ id: SETTING_ITEM_ID.CONNECTIONS_SLACK, section: "connections" },
	{ id: SETTING_ITEM_ID.CONNECTIONS_GITHUB, section: "connections" },
	{ id: SETTING_ITEM_ID.CONNECTIONS_JIRA, section: "connections" },
	{ id: SETTING_ITEM_ID.CONNECTIONS_NOTION, section: "connections" },

	{ id: SETTING_ITEM_ID.BEHAVIOR_CONFIRM_QUIT, section: "behavior" },

	{ id: SETTING_ITEM_ID.GIT_DELETE_LOCAL_BRANCH, section: "git" },
	{ id: SETTING_ITEM_ID.GIT_BRANCH_PREFIX, section: "git" },

	{ id: SETTING_ITEM_ID.BEHAVIOR_FILE_OPEN_MODE, section: "behavior" },
	{ id: SETTING_ITEM_ID.BEHAVIOR_RESOURCE_MONITOR, section: "behavior" },

	{ id: SETTING_ITEM_ID.GIT_WORKTREE_LOCATION, section: "git" },

	{ id: SETTING_ITEM_ID.BEHAVIOR_OPEN_LINKS_IN_APP, section: "behavior" },
	{ id: SETTING_ITEM_ID.BEHAVIOR_AUTO_RENAME_SESSIONS, section: "behavior" },

	{ id: SETTING_ITEM_ID.AGENTS_ENABLED, section: "agents" },
	{ id: SETTING_ITEM_ID.AGENTS_COMMANDS, section: "agents" },
	{ id: SETTING_ITEM_ID.AGENTS_TASK_PROMPTS, section: "agents" },

	{ id: SETTING_ITEM_ID.TERMINAL_PRESETS, section: "terminal" },
	{ id: SETTING_ITEM_ID.TERMINAL_QUICK_ADD, section: "terminal" },
	{ id: SETTING_ITEM_ID.TERMINAL_SESSIONS, section: "terminal" },
	{ id: SETTING_ITEM_ID.TERMINAL_BACKGROUND_LIMIT, section: "terminal" },
	{ id: SETTING_ITEM_ID.TERMINAL_LINK_BEHAVIOR, section: "terminal" },

	{ id: SETTING_ITEM_ID.LINKS_FILE, section: "links" },
	{ id: SETTING_ITEM_ID.LINKS_URL, section: "links" },
	{ id: SETTING_ITEM_ID.LINKS_SIDEBAR_FILE, section: "links" },
	{ id: SETTING_ITEM_ID.LINKS_PORT, section: "links" },

	{ id: SETTING_ITEM_ID.MODELS_ANTHROPIC, section: "models" },
	{ id: SETTING_ITEM_ID.MODELS_OPENAI, section: "models" },

	{ id: SETTING_ITEM_ID.EXPERIMENTAL_ODIN_V2, section: "experimental" },
	{ id: SETTING_ITEM_ID.EXPERIMENTAL_V1_MIGRATION, section: "experimental" },
	{
		id: SETTING_ITEM_ID.EXPERIMENTAL_INLINE_WORKSPACE_PORTS,
		section: "experimental",
	},
	{
		id: SETTING_ITEM_ID.EXPERIMENTAL_WORKSPACE_AGENTS,
		section: "experimental",
	},
	{
		id: SETTING_ITEM_ID.EXPERIMENTAL_WAIT_FOR_SETUP_BEFORE_AGENT,
		section: "experimental",
	},

	{ id: SETTING_ITEM_ID.PROJECT_NAME, section: "project" },
	{ id: SETTING_ITEM_ID.PROJECT_PATH, section: "project" },
	{ id: SETTING_ITEM_ID.PROJECT_SCRIPTS, section: "project" },
	{ id: SETTING_ITEM_ID.PROJECT_BRANCH_PREFIX, section: "project" },
	{ id: SETTING_ITEM_ID.PROJECT_WORKTREE_LOCATION, section: "project" },
	{ id: SETTING_ITEM_ID.PROJECT_IMPORT_WORKTREES, section: "project" },
	{ id: SETTING_ITEM_ID.PROJECT_ENV_VARS, section: "project" },

	{ id: SETTING_ITEM_ID.PERMISSIONS_FULL_DISK_ACCESS, section: "permissions" },
	{ id: SETTING_ITEM_ID.PERMISSIONS_ACCESSIBILITY, section: "permissions" },
	{ id: SETTING_ITEM_ID.PERMISSIONS_APPLE_EVENTS, section: "permissions" },
];

/**
 * The settings sections Odin shows. The rest configure a workspace UI Odin
 * doesn't use (git, agents, terminal, links, models) — Odin's own behaviour
 * lives on the board, not in a settings panel. `connections` is Odin's own:
 * the credentials its feeds run on.
 *
 * An allowlist rather than a hide-list so anything inherited later stays out
 * until it's deliberately let in. Enforced at the variant gate below, which
 * the sidebar and the per-section item lists both already run through, so
 * one check covers every surface.
 *
 * Hidden sections keep their routes: they are still reachable by direct
 * navigation (the workspace-init toast links to /settings/models). Sections
 * whose routes are gone are gone from here too.
 */
const VISIBLE_SECTIONS = new Set<SettingsSection>([
	"keyboard",
	"connections",
	// Agent-complete banners are Odin's own, so their sound and their macOS
	// banner settings belong here (the section route is named `ringtones`).
	"ringtones",
]);

const SECTION_BY_ITEM_ID = new Map<SettingItemId, SettingsSection>(
	SETTINGS_ITEMS.map((item) => [item.id, item.section]),
);

export function isItemVisible(
	itemId: SettingItemId,
	visibleItems: SettingItemId[] | null | undefined,
): boolean {
	return !visibleItems || visibleItems.includes(itemId);
}

/**
 * Items in `section` that are allowed for the active v1/v2 variant. Returns
 * an array suitable for passing to `isItemVisible` at the leaf — never
 * `null`, so variant-hidden items are always excluded.
 */
export function getVisibleItemsForSection(params: {
	section: SettingsSection;
	isV2: boolean;
}): SettingItemId[] {
	const { section, isV2 } = params;
	return SETTINGS_ITEMS.filter(
		(item) =>
			item.section === section && isItemAllowedForVariant(item.id, isV2),
	).map((item) => item.id);
}

/**
 * Sections that contain at least one item allowed for the active variant.
 * Sections with no allowed items (e.g. `git` in v2, `links` in v1) should
 * be hidden from the sidebar entirely.
 */
export function getAllowedSectionsForVariant(
	isV2: boolean,
): Set<SettingsSection> {
	const sections = new Set<SettingsSection>();
	for (const item of SETTINGS_ITEMS) {
		if (isItemAllowedForVariant(item.id, isV2)) sections.add(item.section);
	}
	return sections;
}
