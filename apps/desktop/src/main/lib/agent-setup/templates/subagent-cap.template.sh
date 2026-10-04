#!/bin/bash
{{MARKER}}
# PreToolUse(Agent|Task): caps how many Claude subagents run at once across
# every session on this machine. Each subagent brings its own tsc / bun test /
# build, and a few sessions fanning out in parallel is enough to peg a laptop.
#
# "Running" is read off disk, not tracked: every subagent appends to
# <claude config>/projects/<project>/<session>/subagents/agent-*.jsonl as it
# works, so a transcript written in the last few minutes is a live subagent -
# including ones launched before this hook existed or whose session crashed.
#
# Override the cap with ODIN_MAX_SUBAGENTS (Claude settings.json "env").

CAP=${ODIN_MAX_SUBAGENTS:-{{DEFAULT_CAP}}}
PROJECTS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
PENDING="${ODIN_HOME_DIR:-$HOME/.odin}/subagents"
mkdir -p "$PENDING" || exit 0

INPUT=$(cat)
TOOL_USE_ID=$(echo "$INPUT" | grep -oE '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')

# Parallel Agent calls in one message fire their hooks concurrently. macOS has
# no flock, so mkdir is the lock; a lock left by a killed hook is broken after ~2s.
for _ in $(seq 40); do
  mkdir "$PENDING/.lock" 2>/dev/null && break
  sleep 0.05
done
mkdir "$PENDING/.lock" 2>/dev/null
trap 'rmdir "$PENDING/.lock" 2>/dev/null' EXIT

# ponytail: "active" = wrote in the last 3 min. A subagent sitting in one Bash
# call longer than that (a long test run) drops out of the count until it
# writes again.
ACTIVE=$(find "$PROJECTS"/*/*/subagents -name 'agent-*.jsonl' -mtime -3m 2>/dev/null | wc -l | tr -d ' ')
# A just-approved spawn has no transcript yet; hold its slot for 30s so a
# burst of parallel Agent calls can't all slip under the cap.
find "$PENDING" -type f ! -name '.*' -mtime +30s -delete 2>/dev/null
RESERVED=$(find "$PENDING" -type f ! -name '.*' | wc -l | tr -d ' ')
RUNNING=$((ACTIVE + RESERVED))

if [ "$RUNNING" -ge "$CAP" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' \
    "$RUNNING subagents are already running across all Claude sessions on this machine (cap $CAP). Do not launch another one: do this work yourself in this session, one step at a time, or wait for your running subagents to finish."
  exit 0
fi
touch "$PENDING/${TOOL_USE_ID:-$$}"
exit 0
