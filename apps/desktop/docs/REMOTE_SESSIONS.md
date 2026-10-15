# Remote sessions: Claude runs on the server

## Problem

Remote connect (Settings > Advanced > Remote server) moves only host-service, the
workspace backend, to the server. Every Claude session - Dev Board, New Session,
Start session on Tasks, Raven, Night Agent, automations, resume - is still spawned
by the desktop app's own terminal stack:

```
renderer terminal.createOrAttach -> electron main terminal router
  -> WorkspaceRuntimeRegistry.getDefault() (always local)
  -> DaemonTerminalManager -> the laptop's terminal-host daemon
```

So agents run on the laptop and stop when it sleeps. The goal: with a remote
connected, sessions run on the server, keep working with the laptop closed, and
the board shows the right state when the laptop comes back.

## Approach

Keep the renderer's terminal API exactly as it is and swap the backend under it.
`WorkspaceRuntime` was built for this ("local daemon today, or cloud/SSH in the
future"); host-service already has a durable PTY layer (pty-daemon, detached,
adopted across restarts), a terminal WebSocket, and an agent-hook endpoint.

### 1. Routing runtime (desktop main)
`RoutingTerminalRuntime` becomes the default runtime. In remote mode every
terminal operation goes to `RemoteTerminalRuntime`; otherwise to the local one.
It forwards both backends' events (`data:`, `exit:`, `disconnect:`,
`terminalExit`), so the router, the renderer stream and the board are unchanged.
A pane alive on the laptop stays there, so sessions started before connecting
keep running locally.

Remote mode follows the user's choice, not the tunnel: it holds from Connect to
Disconnect, survives drops (the manager reconnects with backoff) and app restarts
(the active connection is resumed at startup). While the tunnel is down the
session list throws instead of answering "none" - an empty list would read as
every remote session having died, and the board would close or re-launch them on
the laptop.

### 2. RemoteTerminalRuntime (desktop main)
Implements `TerminalRuntime` against host-service through the SSH tunnel.
The host terminal id is the pane id.
- `createOrAttach`: attach if the server has the session, else create it; open
  `WS /terminal/<paneId>`; return a snapshot so the pane paints immediately.
- `write` / `resize` / `detach`: over the WebSocket. `kill`: `terminal.killSession`.
- `management.listSessions`, `readScreen`, `getSession`: `terminal.listSessions` /
  `terminal.snapshot`, mapped to the local shapes (board liveness, screen scan).
- Reconnects the WebSockets after the tunnel drops; output written meanwhile is
  replayed by the server.

### 3. host-service
- `terminal.createSession` gains `command`: run it as `$SHELL -lc <command>`, so the
  PTY ends when Claude ends - the same contract as the local daemon - instead of
  typing it into an interactive shell.
- PTY env adds `ODIN_PANE_ID` / `ODIN_TAB_ID` (the hooks and shell rule key on them).
- A session's cwd gets a host project + workspace on demand (`project` import of the
  repo on the server), which the terminal layer and its reaper require.

### 4. Paths live on the server
In remote mode, a path the laptop can't see is a server path:
- `projects.openFromPath` validates it on the server instead of the laptop disk.
- The default session folder is kept per side (`remoteDefaultRepo` beside
  `defaultRepo`); when none is set, the launcher asks for a server path (checked on
  the server) instead of opening the laptop's folder dialog.
- `filesystem.writeFile` / `createDirectory` for a remote workspace's session files
  (`.odin/task-*.md`, rules, attachments) write on the server.

### 5. Server agent setup (at connect)
- `<odin folder>/hooks/{notify,subagent-cap,shell-rule}.sh`, rendered from the same
  templates as the laptop's.
- Odin's hooks merged into the server's `~/.claude/settings.json`, including
  `skipDangerousModePermissionPrompt`. They are gated on `ODIN_HOME_DIR`, so they do
  nothing for Claude run outside Odin.
- `claude` on the server's PATH for sessions: the system one if present, otherwise
  Claude Code installed into `<odin folder>` with Odin's own Node.

### 6. Status survives the laptop closing
- On the server, `notify.sh` posts each hook to host-service (`notifications.hook`),
  which records the last state per session and broadcasts it on `/events`.
- Desktop main subscribes to `/events` and feeds the same `AGENT_LIFECYCLE` path the
  board already uses, so cards move as they do locally.
- On every (re)connect it replays each live session's last recorded state, and the
  liveness poll marks sessions that ended meanwhile - so after a night with the lid
  shut, the board shows what actually happened.

### 7. Connections run on the server
With `ODIN_REMOTE_CORE=1` the server's host-service also serves Odin's own
connection routers (`connections`, `work`, `slack`, `notion`, `backlogReview`,
`workLog`) at `/odin-trpc` (`main/odin-core`), against the server's `odin.json`
and local DB. The renderer sends those namespaces there in remote mode
(`renderer/lib/remote-core-link.ts`), so feeds, token refresh and the queues keep
going with the laptop shut. On first connect the laptop's `odin.json` is carried
over if the server has none.
- Sign-in starts on the server, which returns the authorize URL; the laptop opens
  it, and the `odin://` callback is forwarded to `/odin-trpc/oauth.complete`, where
  the sign-in's state and client secret are.
- The desktop modules load on plain Node through a small `electron` stand-in
  written to `<odin folder>/node_modules/electron`.

### 8. Session tools on the server
`$ODIN_PORT` in a server session points at a loopback server in the same process
(`main/odin-core/session-tools.ts`): `/read`, `/file` and `/odin` (`api`, `call`,
`service`). The ones that drive the window (`/shell/run`, board actions) answer
503 with a message saying so.

### 9. The board's settings reach the server
The stores the schedulers read (tasks and automations, Night Agent settings,
rules, launch limits, Claude command, session instructions, reminders, reply
watches) are mirrored to `<odin folder>/state` (`state-mirror.ts`): each change
goes up, and on connect the side that changed last wins. The window also sends
where sessions start, the board's cards and the Night Agent's queue
(`shared/server-board.ts`). The server's own bookkeeping lives under `server:`
keys, which nothing outside the server can write, so no key has two writers.

### 10. Schedulers on the server
`main/odin-core/scheduler.ts` runs the clocks that start sessions, so they work
with the laptop shut, and the window's own copies stand down in remote mode:
- Automations: due cron rows of the active profile, stamped in
  `server:automation-runs`.
- Slack auto-launch: messages carrying the launch reaction, once each.
- The launch queue: the gate reads the server's CPU, memory and disk and its live
  sessions. Tasks the window queues are handed over and started here.
- Night Agent: picks first, then the model's ranking of Next in line as the
  window last built it; one session at a time, logged in `server:night`.

Each session started this way gets a card record (`server:cards`); the window
puts it on the board when it next connects, attached to the running session
(`useServerBoard`). The server process runs in the laptop's time zone, so cron
times and the night window mean what they say.

## Still on the laptop

UI-facing, so fine to pause while the laptop is shut. They catch up when it opens:
- Reminders and reply-watch banners (desktop notifications), and the Telegram bot.
- Idle close and auto-resume, which act on the board's own view of each card.
- The periodic backlog sweep, which fills the Review screen.
- The header's load and disk chips, which still show the laptop (the launch gate
  itself reads the server).
- Transcript features reading `~/.claude/projects` (chat view, briefs, session
  history search, looping detection), the diff tab and PR states for server
  sessions.
- A Sign in to Claude flow for the server (until then, sign in once in a session's
  terminal).

## Testing
- Unit tests for the runtime mapping, command building and setup rendering.
- An end-to-end harness that drives the real `RemoteTerminalRuntime` against a real
  host-service on a Linux server: launch, stream, input, resize, tunnel drop and
  reconnect with status catch-up, exit, kill.
- The same harness against the Odin core: connections and OAuth exchange, session
  tools from inside a server PTY, the state mirror's rules, and the schedulers
  (an automation firing, the queue held and released by the server's load, the
  Night Agent starting a pick and waiting on it).
- CI (lint, typecheck, tests, smoke) for the local path, which must not change.
