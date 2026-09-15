# Codex's native notify callback only reports completion, so the wrapper uses
# Codex's process-scoped TUI session log for Start/permission events. Avoid
# tailing global rollout files: concurrent Codex sessions share that directory.
_odin_debug_enabled="0"
case "$ODIN_DEBUG_HOOKS" in
  1|true|TRUE|True|yes|YES|on|ON) _odin_debug_enabled="1" ;;
esac
if [ "$_odin_debug_enabled" != "1" ] && { [ "$ODIN_ENV" = "development" ] || [ "$NODE_ENV" = "development" ]; }; then
  _odin_debug_enabled="1"
fi

_odin_notify_path="{{NOTIFY_PATH}}"
_odin_debug_log="${ODIN_HOOK_DEBUG_LOG:-/tmp/odin-codex-hooks.log}"
_odin_has_odin_context="0"
[ -n "$ODIN_TERMINAL_ID$ODIN_TAB_ID$ODIN_PANE_ID" ] && _odin_has_odin_context="1"
ODIN_CODEX_SESSION_WATCHER_PID=""
_odin_codex_args=()

_odin_debug() {
  [ "$_odin_debug_enabled" = "1" ] || return 0
  printf '%s [codex-wrapper] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" "$*" >> "$_odin_debug_log" 2>/dev/null || true
}

_odin_toml_escape() {
  local _odin_value="$1"
  _odin_value="${_odin_value//\\/\\\\}"
  _odin_value="${_odin_value//\"/\\\"}"
  printf '%s' "$_odin_value"
}

_odin_configure_project_trust() {
  [ -n "${ODIN_WORKSPACE_PATH:-}" ] || return 0

  local _odin_workspace_codex_home="$ODIN_WORKSPACE_PATH/.codex"
  [ -f "$_odin_workspace_codex_home/config.toml" ] || return 0

  local _odin_workspace_path_toml
  _odin_workspace_path_toml="$(_odin_toml_escape "$ODIN_WORKSPACE_PATH")"
  _odin_codex_args+=("-c" "projects={\"$_odin_workspace_path_toml\"={trust_level=\"trusted\"}}")
  _odin_debug "using trusted workspace Codex project config path=$ODIN_WORKSPACE_PATH"
}

_odin_configure_project_trust

_odin_child_pids_for() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -P "$1" 2>/dev/null || true
    return 0
  fi
  ps -axo pid=,ppid= 2>/dev/null | awk -v ppid="$1" '$2 == ppid { print $1 }' 2>/dev/null || true
}

_odin_cleanup_session_watcher() {
  if [ -n "$ODIN_CODEX_SESSION_WATCHER_PID" ]; then
    _odin_watcher_pid="$ODIN_CODEX_SESSION_WATCHER_PID"
    _odin_child_pids="$(_odin_child_pids_for "$_odin_watcher_pid" | tr '\n' ' ')"
    for _odin_child_pid in $_odin_child_pids; do
      kill -TERM "$_odin_child_pid" >/dev/null 2>&1 || true
    done
    kill -TERM "$_odin_watcher_pid" >/dev/null 2>&1 || true
    sleep 0.2
    _odin_child_pids="$_odin_child_pids $(_odin_child_pids_for "$_odin_watcher_pid" | tr '\n' ' ')"
    for _odin_child_pid in $_odin_child_pids; do
      kill -KILL "$_odin_child_pid" >/dev/null 2>&1 || true
    done
    kill -KILL "$_odin_watcher_pid" >/dev/null 2>&1 || true
    _odin_debug "session watcher cleanup signaled pid=$_odin_watcher_pid"
    ODIN_CODEX_SESSION_WATCHER_PID=""
  fi
}

_odin_exit_trap() {
  _odin_status=$?
  trap - EXIT HUP INT TERM
  _odin_cleanup_session_watcher
  exit "$_odin_status"
}

trap _odin_exit_trap EXIT HUP INT TERM

if [ "$_odin_has_odin_context" = "1" ] && [ -f "$_odin_notify_path" ]; then
  export CODEX_TUI_RECORD_SESSION="${CODEX_TUI_RECORD_SESSION:-1}"
  export CODEX_TUI_SESSION_LOG_PATH="${TMPDIR:-/tmp}/odin-codex-session-$$_$(date +%s).jsonl"
  _odin_debug "session watcher starting terminalId=$ODIN_TERMINAL_ID tabId=$ODIN_TAB_ID paneId=$ODIN_PANE_ID log=$CODEX_TUI_SESSION_LOG_PATH notify=$_odin_notify_path"

  (
    _odin_notify="$_odin_notify_path"
    _odin_session_log="$CODEX_TUI_SESSION_LOG_PATH"

    _odin_emit_event() {
      _odin_payload=$(printf '{"hook_event_name":"%s"}' "$1")
      _odin_debug "emitting $1 via $_odin_notify"
      bash "$_odin_notify" "$_odin_payload" >/dev/null 2>&1 || true
    }

    _odin_i=0
    while [ ! -f "$_odin_session_log" ] && [ "$_odin_i" -lt 200 ]; do
      _odin_i=$((_odin_i + 1))
      sleep 0.1
    done
    if [ ! -f "$_odin_session_log" ]; then
      _odin_debug "session log not found path=$_odin_session_log"
      exit 0
    fi
    _odin_debug "watching session=$_odin_session_log"

    tail -n +1 -F "$_odin_session_log" 2>/dev/null | while IFS= read -r _odin_line; do
      case "$_odin_line" in
        *'"dir":"from_tui"'*'"kind":"op"'*'"UserTurn"'*) _odin_emit_event "Start" ;;
        *'_approval_request"'*) _odin_emit_event "PermissionRequest" ;;
      esac
    done
  ) 2>/dev/null &
  ODIN_CODEX_SESSION_WATCHER_PID=$!
  _odin_debug "session watcher pid=$ODIN_CODEX_SESSION_WATCHER_PID"
else
  _odin_notify_exists="0"
  [ -f "$_odin_notify_path" ] && _odin_notify_exists="1"
  _odin_debug "session watcher disabled hasOdinContext=$_odin_has_odin_context terminalId=$ODIN_TERMINAL_ID tabId=$ODIN_TAB_ID paneId=$ODIN_PANE_ID notifyExists=$_odin_notify_exists notify=$_odin_notify_path"
fi

# `hooks` (formerly `codex_hooks`) is stable and default-enabled in codex
# >=0.129; the legacy `notify=...` callback remains the completion source.
"$REAL_BIN" "${_odin_codex_args[@]}" --enable hooks -c 'notify=["bash","{{NOTIFY_PATH}}"]' "$@"
ODIN_CODEX_STATUS=$?
_odin_debug "codex exited status=$ODIN_CODEX_STATUS"

_odin_cleanup_session_watcher

trap - EXIT HUP INT TERM
exit "$ODIN_CODEX_STATUS"
