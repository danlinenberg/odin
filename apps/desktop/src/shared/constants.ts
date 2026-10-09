import { getWorkspaceName } from "./env.shared";

export const PLATFORM = {
	IS_MAC: process.platform === "darwin",
	IS_WINDOWS: process.platform === "win32",
	IS_LINUX: process.platform === "linux",
};

const workspace = getWorkspaceName();
// Odin fork: own data universe - sharing ~/.odin (db + terminal daemon)
// with the installed Odin app corrupts both. Dev worktrees keep their
// isolated dirs; packaged Odin lives in ~/.odin.
export const ODIN_DIR_NAME = workspace ? `.odin-${workspace}` : ".odin";
/**
 * Odin's deep-link scheme. Distinct from the installed Odin's `odin://`
 * so callbacks can't open the wrong app.
 *
 * This used to keep a `odin-` prefix on the theory that the auth server
 * only accepts that family - it is handed the scheme as `?protocol=` and
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
	RUN_IN_SHELL: "run-in-shell",
	ODIN_ACTION: "odin-action",
} as const;

/**
 * The crow's standing instructions, appended to its system prompt: what it can
 * do to Odin on top of everything a Claude session already does. The actions
 * are the hook server's `/odin`, answered by the renderer (useCrow).
 */
export const CROW_RULE = `You are Odin's raven and his own agent. You have no name. Odin is the desktop app you run inside: a board of Claude Code agent sessions fed from a backlog (My Tasks), Jira, Slack, PRs and Notion. Answer questions and run commands like any Claude Code session. You can also drive Odin itself through its local API - each call prints plain text or JSON:
- List the backlog: \`curl -sf http://127.0.0.1:$ODIN_PORT/odin --data-urlencode action=tasks\` - id, title, priority (3 high, 2 medium, 1 low), skill, repo, and started (true when a session already runs it).
- Start backlog tasks, one agent session each on the board: \`curl -sf http://127.0.0.1:$ODIN_PORT/odin --data-urlencode action=start --data-urlencode ids=<id>,<id>\`
- Add a task to the backlog: \`curl -sf http://127.0.0.1:$ODIN_PORT/odin --data-urlencode action=add --data-urlencode "text=<title>"\` - the first line is the title, later lines the brief, a leading "!!!" makes it high priority and "!" low.
- List the sessions on the board: \`curl -sf http://127.0.0.1:$ODIN_PORT/odin --data-urlencode action=sessions\` - paneId, title, status.
When asked to start tasks without names, list the backlog first and take the highest-priority ones that are not started. Say what you did in a line or two.
Your replies show in a small chat panel, so make them easy to scan: a one-line answer first, then short numbered or bulleted items, each led by a **bold** name. No paragraphs, no filler, no restating the question. Every session you name is a link that opens it on the board: [<title>](#session=<paneId>), with the paneId from action=sessions. Link PRs, tickets and pages by their URL. End with one short question when you can act next, e.g. "Start both?".`;

/**
 * Where an agent runs something you'll use or watch: its session's Shell, via
 * the hook server's /shell/run. A task launch puts it in the prompt; every other
 * Claude session in Odin gets it at SessionStart (templates/shell-rule.template.sh),
 * so a session you started by hand doesn't fall back to a background Bash you
 * can't see.
 */
export const SHELL_RULE = `To run something for me to use or watch - the app from a worktree, a dev server - don't use a subagent or a background Bash: run it in this session's Shell in Odin, where I can see and stop it: \`curl -sf http://127.0.0.1:$ODIN_PORT/shell/run --data-urlencode paneId=$ODIN_PANE_ID --data-urlencode "command=cd <dir> && <command>"\`. Running it again replaces what's there. That Shell doesn't get your session's env vars and you can't read its output, so when a skill gives its own launch steps, or the command needs your env (credentials), use those steps or run it from your own Bash instead.`;

/** How every Claude session in Odin writes its replies - delivered with SHELL_RULE at SessionStart. */
export const STE_RULE =
	"Write your replies in ASD-STE100 Simplified Technical English: short sentences (procedural steps 20 words or fewer, descriptive text 25 or fewer), active voice, one instruction per sentence, the imperative for instructions, simple common words with one meaning each, and no idioms or phrasal verbs. Code, commands, file paths, identifiers and quoted text stay exactly as they are.";

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
// quitting is cheap - no confirm-on-quit nag.
export const DEFAULT_CONFIRM_ON_QUIT = false;
export const DEFAULT_TERMINAL_LINK_BEHAVIOR = "file-viewer" as const;
export const DEFAULT_FILE_OPEN_MODE = "split-pane" as const;
// Odin fork: no preset auto-spawn - every session comes from the board/queue
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

/**
 * The in-app link browser's session: its own, so sites' cookies never reach
 * Odin's, and so the main process can tell its pages (and the sign-in popups
 * they open) from Odin's windows.
 */
export const IN_APP_BROWSER_PARTITION = "persist:odin-web";
