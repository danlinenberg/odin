import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { v4 as uuidv4 } from "uuid";

import type {
	AgentCustomDefinition,
	AgentPresetOverrideEnvelope,
	BranchPrefixMode,
	ExternalApp,
	FileOpenMode,
	GitHubStatus,
	GitStatus,
	TerminalLinkBehavior,
	TerminalPreset,
	WorkspaceType,
} from "./zod";

/**
 * Projects table - represents a git repository that the user has opened
 */
export const projects = sqliteTable(
	"projects",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		mainRepoPath: text("main_repo_path").notNull(),
		name: text("name").notNull(),
		color: text("color").notNull(),
		tabOrder: integer("tab_order"),
		lastOpenedAt: integer("last_opened_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		configToastDismissed: integer("config_toast_dismissed", {
			mode: "boolean",
		}),
		defaultBranch: text("default_branch"),
		workspaceBaseBranch: text("workspace_base_branch"),
		githubOwner: text("github_owner"),
		branchPrefixMode: text("branch_prefix_mode").$type<BranchPrefixMode>(),
		branchPrefixCustom: text("branch_prefix_custom"),
		worktreeBaseDir: text("worktree_base_dir"),
		hideImage: integer("hide_image", { mode: "boolean" }),
		iconUrl: text("icon_url"),
		neonProjectId: text("neon_project_id"),
		defaultApp: text("default_app").$type<ExternalApp>(),
	},
	(table) => [
		index("projects_main_repo_path_idx").on(table.mainRepoPath),
		index("projects_last_opened_at_idx").on(table.lastOpenedAt),
	],
);

export type InsertProject = typeof projects.$inferInsert;
export type SelectProject = typeof projects.$inferSelect;

/**
 * Worktrees table - represents a git worktree within a project
 */
export const worktrees = sqliteTable(
	"worktrees",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		branch: text("branch").notNull(),
		baseBranch: text("base_branch"), // The branch this worktree was created from
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		gitStatus: text("git_status", { mode: "json" }).$type<GitStatus>(),
		githubStatus: text("github_status", { mode: "json" }).$type<GitHubStatus>(),
		// Track whether this worktree was created by Odin or imported from external source
		// Used to prevent accidental deletion of user-created worktrees
		createdByOdin: integer("created_by_odin", { mode: "boolean" })
			.notNull()
			.default(true),
	},
	(table) => [
		index("worktrees_project_id_idx").on(table.projectId),
		index("worktrees_branch_idx").on(table.branch),
	],
);

export type InsertWorktree = typeof worktrees.$inferInsert;
export type SelectWorktree = typeof worktrees.$inferSelect;

/**
 * Workspaces table - represents an active workspace (worktree or branch-based)
 */
export const workspaces = sqliteTable(
	"workspaces",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		worktreeId: text("worktree_id").references(() => worktrees.id, {
			onDelete: "cascade",
		}), // Only set for type="worktree"
		type: text("type").notNull().$type<WorkspaceType>(),
		branch: text("branch").notNull(), // Branch name for both types
		name: text("name").notNull(),
		tabOrder: integer("tab_order").notNull(),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		lastOpenedAt: integer("last_opened_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		isUnread: integer("is_unread", { mode: "boolean" }).default(false),
		// Whether the workspace has an auto-generated name (branch name) that should prompt for rename
		isUnnamed: integer("is_unnamed", { mode: "boolean" }).default(false),
		// Timestamp when deletion was initiated. Non-null means deletion in progress.
		// Workspaces with deletingAt set should be filtered out from queries.
		deletingAt: integer("deleting_at"),
		// Allocated port base for multi-worktree dev instances.
		// Each workspace gets a range of 10 ports starting from this base.
		portBase: integer("port_base"),
		sectionId: text("section_id").references(() => workspaceSections.id, {
			onDelete: "set null",
		}),
	},
	(table) => [
		index("workspaces_project_id_idx").on(table.projectId),
		index("workspaces_worktree_id_idx").on(table.worktreeId),
		index("workspaces_last_opened_at_idx").on(table.lastOpenedAt),
		index("workspaces_section_id_idx").on(table.sectionId),
		// NOTE: Migration 0006 creates an additional partial unique index:
		// CREATE UNIQUE INDEX workspaces_unique_branch_per_project
		//   ON workspaces(project_id) WHERE type = 'branch'
		// This enforces one branch workspace per project. Drizzle's schema DSL
		// doesn't support partial/filtered indexes, so this constraint is only
		// applied via the migration, not schema push. See migration 0006 for details.
	],
);

export type InsertWorkspace = typeof workspaces.$inferInsert;
export type SelectWorkspace = typeof workspaces.$inferSelect;

/**
 * Workspace sections - user-created groups within a project for organizing workspaces
 */
export const workspaceSections = sqliteTable(
	"workspace_sections",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		tabOrder: integer("tab_order").notNull(),
		isCollapsed: integer("is_collapsed", { mode: "boolean" }).default(false),
		color: text("color"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [index("workspace_sections_project_id_idx").on(table.projectId)],
);

export type InsertWorkspaceSection = typeof workspaceSections.$inferInsert;
export type SelectWorkspaceSection = typeof workspaceSections.$inferSelect;

export const settings = sqliteTable("settings", {
	id: integer("id").primaryKey().default(1),
	lastActiveWorkspaceId: text("last_active_workspace_id"),
	terminalPresets: text("terminal_presets", { mode: "json" }).$type<
		TerminalPreset[]
	>(),
	terminalPresetsInitialized: integer("terminal_presets_initialized", {
		mode: "boolean",
	}),
	agentPresetOverrides: text("agent_preset_overrides", {
		mode: "json",
	}).$type<AgentPresetOverrideEnvelope>(),
	agentCustomDefinitions: text("agent_custom_definitions", {
		mode: "json",
	}).$type<AgentCustomDefinition[]>(),
	agentPresetPermissionsMigratedAt: integer(
		"agent_preset_permissions_migrated_at",
	),
	// ponytail: dead since the ringtone picker was removed; kept to avoid a
	// SQLite table rebuild. Drop it if the settings table is ever migrated.
	selectedRingtoneId: text("selected_ringtone_id"),
	activeOrganizationId: text("active_organization_id"),
	confirmOnQuit: integer("confirm_on_quit", { mode: "boolean" }),
	terminalLinkBehavior: text(
		"terminal_link_behavior",
	).$type<TerminalLinkBehavior>(),
	terminalPersistence: integer("persist_terminal", { mode: "boolean" }).default(
		true,
	),
	autoApplyDefaultPreset: integer("auto_apply_default_preset", {
		mode: "boolean",
	}),
	waitForSetupBeforeAgent: integer("wait_for_setup_before_agent", {
		mode: "boolean",
	}),
	branchPrefixMode: text("branch_prefix_mode").$type<BranchPrefixMode>(),
	branchPrefixCustom: text("branch_prefix_custom"),
	notificationSoundsMuted: integer("notification_sounds_muted", {
		mode: "boolean",
	}),
	notificationVolume: integer("notification_volume"),
	deleteLocalBranch: integer("delete_local_branch", { mode: "boolean" }),
	fileOpenMode: text("file_open_mode").$type<FileOpenMode>(),
	showPresetsBar: integer("show_presets_bar", { mode: "boolean" }),
	useCompactTerminalAddButton: integer("use_compact_terminal_add_button", {
		mode: "boolean",
	}),
	terminalFontFamily: text("terminal_font_family"),
	terminalFontSize: integer("terminal_font_size"),
	terminalLineHeight: real("terminal_line_height"),
	terminalLetterSpacing: real("terminal_letter_spacing"),
	terminalFontWeight: integer("terminal_font_weight"),
	terminalLigatures: integer("terminal_ligatures", { mode: "boolean" }),
	terminalMinimumContrast: real("terminal_minimum_contrast"),
	terminalCursorStyle: text("terminal_cursor_style").$type<
		"block" | "bar" | "underline"
	>(),
	terminalCursorBlink: integer("terminal_cursor_blink", { mode: "boolean" }),
	terminalParkedRuntimeCap: integer("terminal_parked_runtime_cap"),
	editorFontFamily: text("editor_font_family"),
	editorFontSize: integer("editor_font_size"),
	editorLineHeight: real("editor_line_height"),
	editorLetterSpacing: real("editor_letter_spacing"),
	editorFontWeight: integer("editor_font_weight"),
	editorLigatures: integer("editor_ligatures", { mode: "boolean" }),
	showResourceMonitor: integer("show_resource_monitor", { mode: "boolean" }),
	worktreeBaseDir: text("worktree_base_dir"),
	openLinksInApp: integer("open_links_in_app", { mode: "boolean" }),
	defaultEditor: text("default_editor").$type<ExternalApp>(),
	exposeHostServiceViaRelay: integer("expose_host_service_via_relay", {
		mode: "boolean",
	}),
});

export type InsertSettings = typeof settings.$inferInsert;
export type SelectSettings = typeof settings.$inferSelect;

export type V1MigrationKind =
	| "project"
	| "workspace"
	| "preset"
	| "settings"
	| "terminal";
export type V1MigrationStatus = "success" | "linked" | "error" | "skipped";

export const v1MigrationState = sqliteTable(
	"v1_migration_state",
	{
		v1Id: text("v1_id").notNull(),
		kind: text("kind").notNull().$type<V1MigrationKind>(),
		v2Id: text("v2_id"),
		organizationId: text("organization_id").notNull(),
		status: text("status").notNull().$type<V1MigrationStatus>(),
		reason: text("reason"),
		migratedAt: integer("migrated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.v1Id, table.kind],
		}),
		index("v1_migration_state_v2_id_idx").on(table.v2Id),
	],
);

export type InsertV1MigrationState = typeof v1MigrationState.$inferInsert;
export type SelectV1MigrationState = typeof v1MigrationState.$inferSelect;

// =============================================================================
// Synced tables - mirrored from cloud Postgres via Electric SQL
// Column names match Postgres exactly (snake_case) so Electric data writes directly
// =============================================================================

export type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";
export type IntegrationProvider = "linear";

/**
 * Users table - synced from cloud
 */
export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(),
		clerk_id: text("clerk_id").notNull().unique(),
		name: text("name").notNull(),
		email: text("email").notNull().unique(),
		avatar_url: text("avatar_url"),
		deleted_at: text("deleted_at"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("users_email_idx").on(table.email),
		index("users_clerk_id_idx").on(table.clerk_id),
	],
);

export type InsertUser = typeof users.$inferInsert;
export type SelectUser = typeof users.$inferSelect;

/**
 * Organizations table - synced from cloud
 */
export const organizations = sqliteTable(
	"organizations",
	{
		id: text("id").primaryKey(),
		clerk_org_id: text("clerk_org_id").unique(),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		github_org: text("github_org"),
		avatar_url: text("avatar_url"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("organizations_slug_idx").on(table.slug),
		index("organizations_clerk_org_id_idx").on(table.clerk_org_id),
	],
);

export type InsertOrganization = typeof organizations.$inferInsert;
export type SelectOrganization = typeof organizations.$inferSelect;

/**
 * Organization members table - synced from cloud
 */
export const organizationMembers = sqliteTable(
	"organization_members",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		index("organization_members_organization_id_idx").on(table.organization_id),
		index("organization_members_user_id_idx").on(table.user_id),
	],
);

export type InsertOrganizationMember = typeof organizationMembers.$inferInsert;
export type SelectOrganizationMember = typeof organizationMembers.$inferSelect;

/**
 * Tasks table - synced from cloud
 */
export const tasks = sqliteTable(
	"tasks",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull().unique(),
		title: text("title").notNull(),
		description: text("description"),
		status: text("status").notNull(),
		status_color: text("status_color"),
		status_type: text("status_type"),
		status_position: integer("status_position"),
		priority: text("priority").notNull().$type<TaskPriority>(),
		organization_id: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		repository_id: text("repository_id"),
		assignee_id: text("assignee_id").references(() => users.id, {
			onDelete: "set null",
		}),
		creator_id: text("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		estimate: integer("estimate"),
		due_date: text("due_date"),
		labels: text("labels", { mode: "json" }).$type<string[]>(),
		branch: text("branch"),
		pr_url: text("pr_url"),
		external_provider: text("external_provider").$type<IntegrationProvider>(),
		external_id: text("external_id"),
		external_key: text("external_key"),
		external_url: text("external_url"),
		last_synced_at: text("last_synced_at"),
		sync_error: text("sync_error"),
		started_at: text("started_at"),
		completed_at: text("completed_at"),
		deleted_at: text("deleted_at"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("tasks_slug_idx").on(table.slug),
		index("tasks_organization_id_idx").on(table.organization_id),
		index("tasks_assignee_id_idx").on(table.assignee_id),
		index("tasks_status_idx").on(table.status),
		index("tasks_created_at_idx").on(table.created_at),
	],
);

export type InsertTask = typeof tasks.$inferInsert;
export type SelectTask = typeof tasks.$inferSelect;

/**
 * Browser history table - persists browsing history for URL autocomplete
 */
export const browserHistory = sqliteTable(
	"browser_history",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		url: text("url").notNull().unique(),
		title: text("title").notNull().default(""),
		faviconUrl: text("favicon_url"),
		lastVisitedAt: integer("last_visited_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		visitCount: integer("visit_count").notNull().default(1),
	},
	(table) => [
		index("browser_history_url_idx").on(table.url),
		index("browser_history_last_visited_at_idx").on(table.lastVisitedAt),
	],
);

export type InsertBrowserHistory = typeof browserHistory.$inferInsert;
export type SelectBrowserHistory = typeof browserHistory.$inferSelect;

/**
 * Odin: Slack messages I reacted to with :eyes:, one row per message.
 *
 * Slack is the source of the feed but not of the state — a row survives
 * un-reacting (`unreactedAt` is stamped, the row stays) so a queue item can't
 * vanish from under a session, and `doneAt` is local: Odin never writes back
 * to Slack.
 */
export const slackReactions = sqliteTable(
	"slack_reactions",
	{
		/** `${channelId}:${messageTs}` — Slack's own identity for a message. */
		id: text("id").primaryKey(),
		/**
		 * Which Odin profile's Slack this row came from. Rows from a profile you
		 * aren't in are invisible AND untouched: without this the sync's
		 * "reaction is gone" sweep would retire the other workspace's queue every
		 * time you switched. Rows that predate profiles read as `default`.
		 */
		profileId: text("profile_id").notNull().default("default"),
		channelId: text("channel_id").notNull(),
		channelName: text("channel_name"),
		messageTs: text("message_ts").notNull(),
		authorId: text("author_id"),
		authorName: text("author_name"),
		text: text("text").notNull().default(""),
		permalink: text("permalink"),
		/** When Odin first saw the reaction (not when the message was posted). */
		firstSeenAt: integer("first_seen_at").notNull(),
		lastSeenAt: integer("last_seen_at").notNull(),
		/** Set when the :eyes: is gone; null while it's still on the message. */
		unreactedAt: integer("unreacted_at"),
		/**
		 * When a session was first launched for this row. Persisted rather than
		 * inferred from a live pane: a row worked on yesterday should still read
		 * "In progress" today, after the pane is gone and the app has restarted.
		 */
		startedAt: integer("started_at"),
		/** Local-only "handled" marker. */
		doneAt: integer("done_at"),
	},
	(table) => [
		index("slack_reactions_first_seen_at_idx").on(table.firstSeenAt),
		index("slack_reactions_done_at_idx").on(table.doneAt),
	],
);

export type InsertSlackReaction = typeof slackReactions.$inferInsert;
export type SelectSlackReaction = typeof slackReactions.$inferSelect;

/**
 * The work ledger — one row per feed item you actually started an agent on,
 * kept forever.
 *
 * Separate from `slack_reactions` (and from whatever the other feeds grow)
 * on purpose: those tables mirror an upstream queue and are swept when the
 * source changes — unreact and the row retires, `remove` deletes it outright.
 * The ledger has to outlive the thing it came from, because the question it
 * answers is historical: what landed on me, what did I delegate it to, and
 * what came out. No foreign keys for the same reason — a row here must not
 * disappear because a workspace or project was cleaned up.
 */
export const workLog = sqliteTable(
	"work_log",
	{
		/** `${source}:${externalId}` — one row per item, relaunches reuse it. */
		id: text("id").primaryKey(),
		/** Which feed it came from, matching Pane.odinSource. */
		source: text("source")
			.notNull()
			.$type<"reactions" | "jira" | "pr" | "notion">(),
		/** The source's own id: a Slack `channel:ts`, a Jira key, a PR url. */
		externalId: text("external_id").notNull(),
		/** Back to the thread / issue / PR / page it came from. */
		externalUrl: text("external_url"),
		title: text("title").notNull(),
		/** Who asked — the reporter, the author, the person in the thread. */
		person: text("person"),
		/** Which Odin profile was active, so work and personal stay apart. */
		profileId: text("profile_id").notNull().default("default"),
		startedAt: integer("started_at").notNull(),
		/**
		 * Where the agent ran. Kept so branch and PR can be derived later
		 * without having to catch the moment a session ends.
		 */
		cwd: text("cwd"),
		/** The agent session, for pulling the transcript back up. */
		sessionId: text("session_id"),
		// ponytail: outcome columns are written by nothing yet — derive them
		// from `cwd` on read when something needs them. Capture is what can't
		// be backfilled; derivation always can.
		branch: text("branch"),
		prUrl: text("pr_url"),
		completedAt: integer("completed_at"),
	},
	(table) => [
		index("work_log_started_at_idx").on(table.startedAt),
		index("work_log_source_idx").on(table.source),
	],
);

export type InsertWorkLog = typeof workLog.$inferInsert;
export type SelectWorkLog = typeof workLog.$inferSelect;
