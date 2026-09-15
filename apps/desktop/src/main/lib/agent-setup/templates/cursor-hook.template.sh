#!/bin/bash
{{MARKER}}
# cursor-agent lifecycle hook. Event name comes via argv from hooks.json.

INPUT=$(cat)
HOOK_SESSION_ID=$(printf '%s' "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')

EVENT_TYPE="$1"

NEEDS_RESPONSE=false
case "$EVENT_TYPE" in
  Start|Stop|SessionStart|SessionEnd) ;;
  PermissionRequest) NEEDS_RESPONSE=true ;;
  *) exit 0 ;;
esac

# Permission hooks auto-approve via JSON on stdout. Must print before any
# exit path so cursor-agent isn't left blocked.
if [ "$NEEDS_RESPONSE" = "true" ]; then
  printf '{"continue":true}\n'
fi

V1_EVENT_TYPE="$EVENT_TYPE"
case "$V1_EVENT_TYPE" in
  SessionStart) V1_EVENT_TYPE="Start" ;;
  SessionEnd)   V1_EVENT_TYPE="Stop" ;;
esac

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# This script only fires for Cursor sessions, so an unset ODIN_AGENT_ID
# means Cursor ran outside a Odin wrapper: the cursor-agent CLI stamps
# CURSOR_AGENT/CURSOR_CLI into its env; anything else is the IDE Composer.
AGENT_ID="$ODIN_AGENT_ID"
if [ -z "$AGENT_ID" ]; then
  if [ -n "$CURSOR_AGENT" ] || [ -n "$CURSOR_CLI" ]; then
    AGENT_ID="cursor-agent"
  else
    AGENT_ID="cursor-composer"
  fi
fi

if [ -n "$ODIN_HOST_AGENT_HOOK_URL" ] && [ -n "$ODIN_TERMINAL_ID" ]; then
  PAYLOAD="{\"json\":{\"terminalId\":\"$(json_escape "$ODIN_TERMINAL_ID")\",\"eventType\":\"$(json_escape "$EVENT_TYPE")\",\"agent\":{\"agentId\":\"$(json_escape "$AGENT_ID")\",\"sessionId\":\"$(json_escape "$HOOK_SESSION_ID")\"}}}"

  STATUS_CODE=$(curl -sX POST "$ODIN_HOST_AGENT_HOOK_URL" \
    --connect-timeout 2 --max-time 5 \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    -o /dev/null -w "%{http_code}" 2>/dev/null)

  case "$STATUS_CODE" in
    2*) exit 0 ;;
  esac
fi

[ -z "$ODIN_TAB_ID" ] && [ -z "$ODIN_TERMINAL_ID" ] && exit 0

curl -sG "http://127.0.0.1:${ODIN_PORT:-{{DEFAULT_PORT}}}/hook/complete" \
  --connect-timeout 1 --max-time 2 \
  --data-urlencode "paneId=$ODIN_PANE_ID" \
  --data-urlencode "tabId=$ODIN_TAB_ID" \
  --data-urlencode "workspaceId=$ODIN_WORKSPACE_ID" \
  --data-urlencode "terminalId=$ODIN_TERMINAL_ID" \
  --data-urlencode "sessionId=$HOOK_SESSION_ID" \
  --data-urlencode "hookSessionId=$HOOK_SESSION_ID" \
  --data-urlencode "eventType=$V1_EVENT_TYPE" \
  --data-urlencode "env=$ODIN_ENV" \
  --data-urlencode "version=$ODIN_HOOK_VERSION" \
  > /dev/null 2>&1

exit 0
