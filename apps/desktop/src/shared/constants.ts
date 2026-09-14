import { getWorkspaceName } from "./env.shared";

export const PLATFORM = {
	IS_MAC: process.platform === "darwin",
	IS_WINDOWS: process.platform === "win32",
	IS_LINUX: process.platform === "linux",
};

const workspace = getWorkspaceName();
// Odin fork: own data universe — sharing ~/.odin (db + terminal daemon)
// with the installed Odin app corrupts both. Dev worktrees keep their
// isolated dirs; packaged Odin lives in ~/.odin.
export const ODIN_DIR_NAME = workspace ? `.odin-${workspace}` : ".odin";
/**
 * Odin's deep-link scheme. Distinct from the installed Odin's `odin://`
 * so callbacks can't open the wrong app.
 *
 * This used to keep a `odin-` prefix on the theory that the auth server
 * only accepts that family — it is handed the scheme as `?protocol=` and
 * redirects sign-in back to it. That doesn't apply here: `auth.signIn` is the
 * only caller, and it is unreachable, because every Odin build is made with
 * SKIP_ENV_VALIDATION=1 (scripts/odin-update.sh, scripts/odin-dev.sh), which
 * makes the `_authenticated` guard treat you as signed in and never render
 * /sign-in. Odin holds no session token at all.
 *
 * If cloud sign-in is ever switched back on, check the auth server accepts
 * this scheme before trusting that flow.
 */
export const PROTOCOL_SCHEME = workspace ? `odin-${workspace}` : "odin";
// Project-level directory name (always .odin, not conditional)
export const PROJECT_ODIN_DIR_NAME = ".odin";
export const WORKTREES_DIR_NAME = "worktrees";
export const PROJECTS_DIR_NAME = "projects";
export const CONFIG_FILE_NAME = "config.json";
export const LOCAL_CONFIG_FILE_NAME = "config.local.json";
export const PORTS_FILE_NAME = "ports.json";

export const CONFIG_TEMPLATE = `{
  "setup": [],
  "teardown": [],
  "run": []
}`;

export const NOTIFICATION_EVENTS = {
	AGENT_LIFECYCLE: "agent-lifecycle",
	FOCUS_TAB: "focus-tab",
	FOCUS_V2_NOTIFICATION_SOURCE: "focus-v2-notification-source",
	TERMINAL_EXIT: "terminal-exit",
} as const;

// There is one organization and it is this machine. The nil UUID is what the
// host service already keyed its state directory on, so existing ~/.odin/host
// databases keep working.
export const LOCAL_ORG_ID = "00000000-0000-4000-8000-000000000000";

// Terminal defaults
export const DEFAULT_TERMINAL_SCROLLBACK = 5000;
// Hidden (parked) xterm instances kept fully alive before LRU eviction. (SUPER-1545)
export const DEFAULT_TERMINAL_PARKED_RUNTIME_CAP = 12;
export const MIN_TERMINAL_PARKED_RUNTIME_CAP = 2;
export const MAX_TERMINAL_PARKED_RUNTIME_CAP = 64;

// Default user preference values
// Odin fork: sessions live in the daemon and resurface on relaunch, so
// quitting is cheap — no confirm-on-quit nag.
export const DEFAULT_CONFIRM_ON_QUIT = false;
export const DEFAULT_TERMINAL_LINK_BEHAVIOR = "file-viewer" as const;
export const DEFAULT_FILE_OPEN_MODE = "split-pane" as const;
// Odin fork: no preset auto-spawn — every session comes from the board/queue
// with an explicit task command; preset panes are noise on the kanban.
export const DEFAULT_AUTO_APPLY_DEFAULT_PRESET = false;
export const DEFAULT_WAIT_FOR_SETUP_BEFORE_AGENT = false;
export const DEFAULT_SHOW_PRESETS_BAR = true;
export const DEFAULT_USE_COMPACT_TERMINAL_ADD_BUTTON = true;
export const DEFAULT_TELEMETRY_ENABLED = true;
export const DEFAULT_SHOW_RESOURCE_MONITOR = true;
export const DEFAULT_OPEN_LINKS_IN_APP = false;

// External links (documentation, help resources, etc.)
export const EXTERNAL_LINKS = {
	SETUP_TEARDOWN_SCRIPTS: `${process.env.NEXT_PUBLIC_DOCS_URL}/setup-teardown-scripts`,
} as const;
