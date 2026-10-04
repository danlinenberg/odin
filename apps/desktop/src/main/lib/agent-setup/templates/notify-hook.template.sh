#!/bin/bash
{{MARKER}}
# CLI agent lifecycle hook - POSTs an AgentIdentity payload to the v2
# host-service endpoint, with a v1 Electron hook fallback while both
# terminal stacks are supported.

# Codex passes JSON as argv; Claude/Mastra/Droid/Kimi/Grok pipe via stdin.
if [ -n "$1" ]; then
  INPUT="$1"
else
  INPUT=$(cat)
fi

HOOK_SESSION_ID=$(echo "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
if [ -z "$HOOK_SESSION_ID" ]; then
  # Grok's envelope is camelCase.
  HOOK_SESSION_ID=$(echo "$INPUT" | grep -oE '"sessionId"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
fi
RESOURCE_ID=$(echo "$INPUT" | grep -oE '"resourceId"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
if [ -z "$RESOURCE_ID" ]; then
  RESOURCE_ID=$(echo "$INPUT" | grep -oE '"resource_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
fi
SESSION_ID=${RESOURCE_ID:-$HOOK_SESSION_ID}

# Claude/Mastra/Droid/Kimi use "hook_event_name"; Grok uses camelCase
# "hookEventName" (snake_case values, mapped server-side); Codex uses "type".
EVENT_TYPE=$(echo "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
if [ -z "$EVENT_TYPE" ]; then
  EVENT_TYPE=$(echo "$INPUT" | grep -oE '"hookEventName"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
fi
if [ -z "$EVENT_TYPE" ]; then
  CODEX_TYPE=$(echo "$INPUT" | grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
  case "$CODEX_TYPE" in
    agent-turn-complete|task_complete) EVENT_TYPE="Stop" ;;
    task_started) EVENT_TYPE="Start" ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      EVENT_TYPE="PermissionRequest"
      ;;
  esac
fi

# Grok serializes its configured Notification event as lowercase
# "notification". Only subtypes where the agent is blocked waiting on the
# user count: permission_prompt (tool/plan approval) and elicitation_dialog
# (ask_user_question - the common case, since Odin launches grok with
# --always-approve so tool approvals rarely prompt). Keep the case pattern
# in sync with GROK_BLOCKING_NOTIFICATION_TYPES in agent-wrappers-grok.ts.
if [ "$EVENT_TYPE" = "notification" ]; then
  NOTIFICATION_TYPE=$(echo "$INPUT" | grep -oE '"notificationType"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
  case "$NOTIFICATION_TYPE" in
    permission_prompt|elicitation_dialog) EVENT_TYPE="PermissionRequest" ;;
    *) exit 0 ;;
  esac
fi

has_open_action_items() {
  printf '%s' "$1" | awk '
    { s = s $0 "\n" }
    END {
      gsub(/\\n/, "\n", s)
      u = toupper(s); p = 0; at = 0
      while ((j = index(substr(u, p + 1), "ACTION ITEMS")) > 0) { p += j; at = p }
      # No section at all, but the turn ends on a question: it is still open.
      # The message runs from its opening quote to the first unescaped one.
      if (!at) {
        sub(/^[^"]*"/, "", s)
        if (match(s, /[^\\]"/)) s = substr(s, 1, RSTART)
        sub(/[ \t\n]+$/, "", s)
        exit (s ~ /[?][*_`)]*$/) ? 0 : 1
      }
      t = substr(s, at + 12)
      if (tolower(t) ~ /^[^a-z0-9]*none/) exit 1
      n = split(t, lines, "\n")
      for (k = 1; k <= n; k++)
        if (lines[k] ~ /^[ \t]*([0-9]+[.)]|[-*])[ \t]+[^ \t]/) exit 0
      exit 1
    }'
}

# A turn that ends with background agents still out isn't over: each one's
# completion re-invokes the session, which Stops again when it's done. The
# transcript logs a launch as "status":"async_launched","agentId":"<id>" and
# its end as <task-id><id></task-id>.
# ponytail: an agent whose own transcript sat untouched for 10 min counts as
# gone - a killed session never writes its notification. A subagent parked
# in one Bash call that long lets the card drop to Done/Needs you early.
has_running_background_agents() {
  local transcript=$1 id out
  [ -f "$transcript" ] || return 1
  for id in $(grep -oE '"status":"async_launched","agentId":"[^"]+"' "$transcript" | sed 's/.*"agentId":"//; s/"$//'); do
    grep -q "<task-id>$id</task-id>" "$transcript" && continue
    [ -n "$(find "${transcript%.jsonl}/subagents/agent-$id.jsonl" -mmin -10 2>/dev/null)" ] && return 0
  done
  # Same for a run_in_background Bash (a CI poll): "backgroundTaskId":"<id>" at
  # launch, the same <task-id> at the end. It's running while its process still
  # holds the output file open - a silent poll never touches the file's mtime.
  for id in $(grep -oE '"backgroundTaskId":"[^"]+"' "$transcript" | sed 's/.*:"//; s/"$//'); do
    grep -q "<task-id>$id</task-id>" "$transcript" && continue
    out=$(grep -oE "[^\" ]*/tasks/$id\.output" "$transcript" | head -1)
    [ -n "$out" ] && lsof -t "$out" >/dev/null 2>&1 && return 0
  done
  return 1
}
if [ "$EVENT_TYPE" = "Stop" ]; then
  TRANSCRIPT_PATH=$(echo "$INPUT" | grep -oE '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
  if has_running_background_agents "$TRANSCRIPT_PATH"; then
    EVENT_TYPE="Start"
  else
    case "$INPUT" in
      *'"last_assistant_message"'*)
        has_open_action_items "${INPUT#*\"last_assistant_message\"}" && EVENT_TYPE="PermissionRequest"
        ;;
    esac
  fi
fi

# Only the outermost claude owns the card. A headless `claude -p` that a Stop
# hook, script or Bash call spawns inherits the card's ODIN_* env, so its own
# Start/Stop land on that card too - and its Stop, with no ACTION ITEMS of its
# own, turns the card's Needs you into Done a few seconds after the real turn
# ended. Walk up to the terminal host: a second claude above the first means
# this one is somebody's helper. So does a claude with no terminal of its own:
# a card's claude always runs in its PTY, and a helper a hook detached with
# setsid has no claude above it left to find.
spawned_by_another_claude() {
  local pid=$PPID seen=0 line ppid tty args first i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    line=$(ps -o ppid=,tty=,args= -p "$pid" 2>/dev/null) || return 1
    read -r ppid tty args <<< "$line"
    first=${args%% *}
    case "$args" in *.app/Contents/MacOS/*) return 1 ;; esac
    case "${first##*/}:$args" in
      claude:*|node:*claude-code/cli*)
        [ "$seen" = 1 ] && return 0
        case "$tty" in ""|"?"|"??") return 0 ;; esac
        seen=1
        ;;
    esac
    [ -n "$ppid" ] && [ "$ppid" -gt 1 ] 2>/dev/null || return 1
    pid=$ppid
  done
  return 1
}
spawned_by_another_claude && exit 0

# Claude puts its session_id on every hook it fires. An event without one was
# piped in by hand - an agent testing this script from its own pane, which
# inherits the card's ODIN_* env. Its Stop turned a working card to Done, and
# the queue took that as Odin's checkout coming free: a second session started
# alongside the first one still editing it.
[ "$ODIN_AGENT_ID" = "claude" ] && [ -z "$HOOK_SESSION_ID" ] && exit 0

# UserPromptSubmit normalizes here; other aliases are mapped server-side
# by mapEventType so the wire stays a single source of truth.
[ "$EVENT_TYPE" = "UserPromptSubmit" ] && EVENT_TYPE="Start"

# Never default to "Stop" on parse failure - silent drop is safer than
# a false completion notification.
[ -z "$EVENT_TYPE" ] && exit 0

DEBUG_HOOKS_ENABLED="0"
if [ -n "$ODIN_DEBUG_HOOKS" ]; then
  case "$ODIN_DEBUG_HOOKS" in
    1|true|TRUE|True|yes|YES|on|ON) DEBUG_HOOKS_ENABLED="1" ;;
  esac
elif [ "$ODIN_ENV" = "development" ] || [ "$NODE_ENV" = "development" ]; then
  DEBUG_HOOKS_ENABLED="1"
fi

if [ "$DEBUG_HOOKS_ENABLED" = "1" ]; then
  echo "[notify-hook] event=$EVENT_TYPE terminalId=$ODIN_TERMINAL_ID agentId=$ODIN_AGENT_ID hookSessionId=$HOOK_SESSION_ID resourceId=$RESOURCE_ID paneId=$ODIN_PANE_ID tabId=$ODIN_TAB_ID workspaceId=$ODIN_WORKSPACE_ID" >&2
fi

debug_log() {
  [ "$DEBUG_HOOKS_ENABLED" = "1" ] || return 0
  printf '%s [notify-hook] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" "$*" >> "${ODIN_HOOK_DEBUG_LOG:-/tmp/odin-agent-hooks.log}" 2>/dev/null || true
}

debug_log "event=$EVENT_TYPE terminalId=$ODIN_TERMINAL_ID agentId=$ODIN_AGENT_ID sessionId=$SESSION_ID hookSessionId=$HOOK_SESSION_ID resourceId=$RESOURCE_ID tabId=$ODIN_TAB_ID"

V1_EVENT_TYPE="$EVENT_TYPE"
case "$V1_EVENT_TYPE" in
  Attached|attached|SessionStart|sessionStart|session_start)
    V1_EVENT_TYPE="Start"
    ;;
  Detached|detached|SessionEnd|sessionEnd|session_end)
    V1_EVENT_TYPE="Stop"
    ;;
esac

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [ -n "$ODIN_HOST_AGENT_HOOK_URL" ] && [ -n "$ODIN_TERMINAL_ID" ]; then
  PAYLOAD="{\"json\":{\"terminalId\":\"$(json_escape "$ODIN_TERMINAL_ID")\",\"eventType\":\"$(json_escape "$EVENT_TYPE")\",\"agent\":{\"agentId\":\"$(json_escape "$ODIN_AGENT_ID")\",\"sessionId\":\"$(json_escape "$SESSION_ID")\"}}}"

  STATUS_CODE=$(curl -sX POST "$ODIN_HOST_AGENT_HOOK_URL" \
    --connect-timeout 2 --max-time 5 \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    -o /dev/null -w "%{http_code}" 2>/dev/null)

  if [ "$DEBUG_HOOKS_ENABLED" = "1" ]; then
    echo "[notify-hook] host-service dispatched status=$STATUS_CODE" >&2
  fi
  debug_log "host-service status=$STATUS_CODE url=$ODIN_HOST_AGENT_HOOK_URL"

  case "$STATUS_CODE" in
    2*) exit 0 ;;
  esac
fi

# v1 fallback: Electron localhost hook server. Kept while v1 terminals exist.
[ -z "$ODIN_TAB_ID" ] && [ -z "$SESSION_ID" ] && [ -z "$ODIN_TERMINAL_ID" ] && exit 0

# Every candidate port, best first, until one answers. The port file is the
# app's most recent bind, but it is one shared slot: a second Odin-family app
# that loses the preferred port writes *its* fallback port there, and once
# that app exits the file names a port nobody is listening on. Trusting it
# blindly dropped every event from every live session - the board never heard
# Start, so mid-turn cards sat in Needs you claiming "waiting on your input"
# with no hook left to move them. $ODIN_PORT is the port this session's own
# app had at launch, and the default is where a restarted app lands again.
# Refused connections on loopback come back instantly, so the extra attempts
# only cost anything when the first port was already wrong.
post_v1() {
  curl -sG "http://127.0.0.1:$1/hook/complete" \
    --connect-timeout 1 --max-time 2 \
    --data-urlencode "paneId=$ODIN_PANE_ID" \
    --data-urlencode "tabId=$ODIN_TAB_ID" \
    --data-urlencode "workspaceId=$ODIN_WORKSPACE_ID" \
    --data-urlencode "terminalId=$ODIN_TERMINAL_ID" \
    --data-urlencode "sessionId=$SESSION_ID" \
    --data-urlencode "hookSessionId=$HOOK_SESSION_ID" \
    --data-urlencode "resourceId=$RESOURCE_ID" \
    --data-urlencode "eventType=$V1_EVENT_TYPE" \
    --data-urlencode "env=$ODIN_ENV" \
    --data-urlencode "version=$ODIN_HOOK_VERSION" \
    -o /dev/null -w "%{http_code}" 2>/dev/null
}

PORT_FILE_PORT=$(cat "${ODIN_HOME_DIR}/notifications-port" 2>/dev/null)
TRIED=""
for HOOK_PORT in "$PORT_FILE_PORT" "$ODIN_PORT" "{{DEFAULT_PORT}}"; do
  [ -n "$HOOK_PORT" ] || continue
  case " $TRIED " in *" $HOOK_PORT "*) continue ;; esac
  TRIED="$TRIED $HOOK_PORT"

  STATUS_CODE=$(post_v1 "$HOOK_PORT")
  debug_log "v1 status=$STATUS_CODE port=$HOOK_PORT"
  if [ "$DEBUG_HOOKS_ENABLED" = "1" ]; then
    echo "[notify-hook] v1 dispatched status=$STATUS_CODE port=$HOOK_PORT" >&2
  fi

  case "$STATUS_CODE" in
    2*) break ;;
  esac
done

exit 0
