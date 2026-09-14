#!/bin/bash
{{MARKER}}
# CLI agent lifecycle hook — POSTs an AgentIdentity payload to the v2
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
# (ask_user_question — the common case, since Odin launches grok with
# --always-approve so tool approvals rarely prompt). Keep the case pattern
# in sync with GROK_BLOCKING_NOTIFICATION_TYPES in agent-wrappers-grok.ts.
if [ "$EVENT_TYPE" = "notification" ]; then
  NOTIFICATION_TYPE=$(echo "$INPUT" | grep -oE '"notificationType"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
  case "$NOTIFICATION_TYPE" in
    permission_prompt|elicitation_dialog) EVENT_TYPE="PermissionRequest" ;;
    *) exit 0 ;;
  esac
fi

# UserPromptSubmit normalizes here; other aliases are mapped server-side
# by mapEventType so the wire stays a single source of truth.
[ "$EVENT_TYPE" = "UserPromptSubmit" ] && EVENT_TYPE="Start"

# Never default to "Stop" on parse failure — silent drop is safer than
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
# blindly dropped every event from every live session — the board never heard
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
