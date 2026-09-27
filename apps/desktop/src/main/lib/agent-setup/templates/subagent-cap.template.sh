#!/bin/bash
{{MARKER}}
# Caps how many Claude subagents run at once across every session on this
# machine. Each subagent brings its own tsc / bun test / build, and a few
# sessions fanning out in parallel is enough to peg a laptop.
#
#   PreToolUse(Agent)  takes a slot, or denies the call if none is free
#   SubagentStop       gives back one of the session's slots
#   SessionEnd         gives back all of them
#
# Override the cap with ODIN_MAX_SUBAGENTS (Claude settings.json "env").

CAP=${ODIN_MAX_SUBAGENTS:-{{DEFAULT_CAP}}}
DIR="${ODIN_HOME_DIR:-$HOME/.odin}/subagents"
mkdir -p "$DIR" || exit 0

INPUT=$(cat)
field() {
  echo "$INPUT" | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | grep -oE '"[^"]*"$' | tr -d '"'
}
SID=$(field session_id)
EVENT=$(field hook_event_name)
[ -z "$SID" ] && exit 0

# Parallel Agent calls in one message fire their hooks concurrently. macOS has
# no flock, so mkdir is the lock; a lock left by a killed hook is broken after ~2s.
for _ in $(seq 40); do
  mkdir "$DIR/.lock" 2>/dev/null && break
  sleep 0.05
done
mkdir "$DIR/.lock" 2>/dev/null
trap 'rmdir "$DIR/.lock" 2>/dev/null' EXIT

# ponytail: a slot whose SubagentStop never came (crash, kill -9) expires after
# 60 min; a subagent that genuinely runs longer stops counting against the cap.
find "$DIR" -type f -mmin +60 -delete 2>/dev/null

case "$EVENT" in
  PreToolUse)
    RUNNING=$(find "$DIR" -type f ! -name '.*' | wc -l | tr -d ' ')
    if [ "$RUNNING" -ge "$CAP" ]; then
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' \
        "$RUNNING subagents are already running across all Claude sessions on this machine (cap $CAP). Do not launch another one: do this work yourself in this session, one step at a time, or wait for your running subagents to finish."
      exit 0
    fi
    touch "$DIR/$SID.$(field tool_use_id)"
    ;;
  SubagentStop)
    OLDEST=$(ls -tr "$DIR/$SID".* 2>/dev/null | head -1)
    [ -n "$OLDEST" ] && rm -f "$OLDEST"
    ;;
  SessionEnd)
    rm -f "$DIR/$SID".*
    ;;
esac
exit 0
